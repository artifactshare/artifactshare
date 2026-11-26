import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import YAML from 'yaml'

const workflowDirectory = '.github/workflows'

const secretOwners = new Map([
  [
    'CLOUDFLARE_API_TOKEN',
    ['deploy-production.yml', 'observability-token-probe.yml'],
  ],
  ['NPM_QM_BRIDGE_BOOTSTRAP_TOKEN', ['release-qm-bridge.yml']],
])

// npm provenance needs an OIDC token, and only in the job that publishes.
const writableScopes = new Set(['id-token'])

// Any other writable scope belongs to one named job of one workflow, never to
// a whole workflow: the nightly detector's report job files and closes the
// issues that carry its reported rows.
const scopeOwners = new Map([
  ['issues', [{ file: 'flaky-detector.yml', job: 'report' }]],
])

const hostedRunner =
  /^(?:ubuntu|windows|macos)-(?:latest|\d+(?:\.\d+)?)(?:-arm)?(?:-(?:large|xlarge))?$/u

const readOnlyWrangler =
  /^(?:whoami|dev|docs|types|login|logout|--version|-v\b|versions\s+(?:list|view)|deployments\s+list|d1\s+(?:list|info))/u

const remoteWrites = [/\bdb:apply:remote/u, /\bdeploy:production/u]

const installCommand =
  /(?:^|[\s&|;(])(pnpm|npm|yarn)\s+(?:install|add|ci|i)(?![\w:-])/u

// A publish is the command the shell runs, so the segment has to start with it.
// Text that only mentions a publish, such as an echo, is not one.
const publishCommand =
  /^[\s{(]*(?:(?:then|else|do|time|exec|env|command)\s+)*(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*(?:npm|pnpm)(?:\s+(?:-{1,2}\S+|@\S+|exec|run))*\s+publish(?![\w-])/u

const unisolatedContainer =
  /--privileged|--cap-add|SYS_ADMIN|--(?:network|pid|uts)[= ]host|docker\.sock/iu

const secretReference =
  /secrets(?:\.([A-Za-z0-9_-]+)|\[\s*['"]([A-Za-z0-9_-]+)['"]\s*\]|\[([^\]]*)\])/gu

// A bracket index that is not a literal name hides which secret it reads, so it
// is reported as unresolved instead of resolving to nothing.
function secretNames(value) {
  return [...String(value).matchAll(secretReference)].map(
    (match) => match[1] ?? match[2] ?? `[${match[3].trim()}]`,
  )
}

function writesToProduction(segment) {
  if (remoteWrites.some((pattern) => pattern.test(segment))) return true
  const wrangler = segment.match(/\bwrangler\s+(\S.*)$/u)
  if (!wrangler) return false
  if (/--dry-run\b/u.test(segment)) return false
  return !readOnlyWrangler.test(wrangler[1].trim())
}

function publishesWithProvenance(job) {
  return (job.steps ?? [])
    .flatMap((step) => commandSegments(step.run))
    .some(
      (segment) =>
        publishCommand.test(segment) && /--provenance\b/u.test(segment),
    )
}

function oidcLevel(permissions) {
  return typeof permissions === 'object' && permissions !== null
    ? permissions['id-token']
    : undefined
}

function environmentName(job) {
  const { environment } = job
  return typeof environment === 'string' ? environment : environment?.name
}

function commandSegments(run) {
  return typeof run === 'string' ? run.split(/\n|&&|\|\||;|\|/u) : []
}

function containerOptions(job) {
  return [job.container, ...Object.values(job.services ?? {})]
    .filter((entry) => entry && typeof entry === 'object')
    .map((entry) => String(entry.options ?? ''))
}

function checkFailureVisibility(subject, where, report) {
  const tolerated = subject['continue-on-error']
  if (tolerated === undefined || tolerated === false) return
  // A report job must still run when an expected shard produced no artifact.
  if (subject.uses?.startsWith('actions/download-artifact@')) return
  report('failure-visibility', where, `continue-on-error: ${tolerated}`)
}

function checkPin(uses, where, report) {
  if (uses.startsWith('./')) return
  if (!/^[^@\s]+@[0-9a-f]{40}$/u.test(uses))
    report('pinned-action', where, uses)
}

function ownsScope(scope, owner) {
  return (scopeOwners.get(scope) ?? []).some(
    (entry) => entry.file === owner.file && entry.job === owner.job,
  )
}

function checkPermissions(permissions, where, report, { required, owner }) {
  if (permissions === undefined) {
    if (required) report('read-only-permissions', where, 'not declared')
    return
  }
  if (typeof permissions === 'string') {
    if (permissions !== 'read-all')
      report('read-only-permissions', where, permissions)
    return
  }
  for (const [scope, level] of Object.entries(permissions))
    if (
      level !== 'read' &&
      level !== 'none' &&
      !(
        level === 'write' &&
        (writableScopes.has(scope) || ownsScope(scope, owner))
      )
    )
      report('read-only-permissions', where, `${scope}: ${level}`)
}

function resolveRunnerLabel(label, job, where, report) {
  const matrixKey = String(label).match(
    /^\$\{\{\s*matrix\.([A-Za-z0-9_-]+)\s*\}\}$/u,
  )
  if (!matrixKey) {
    if (String(label).includes('${{')) {
      report('hosted-runner', where, `unresolved ${label}`)
      return []
    }
    return [String(label)]
  }
  const matrix = job.strategy?.matrix ?? {}
  const listed = Array.isArray(matrix[matrixKey[1]]) ? matrix[matrixKey[1]] : []
  const included = Array.isArray(matrix.include)
    ? matrix.include
        .map((entry) => entry?.[matrixKey[1]])
        .filter((value) => value !== undefined)
    : []
  const values = [...listed, ...included].map(String)
  if (values.length === 0) {
    report('hosted-runner', where, `unresolved matrix.${matrixKey[1]}`)
    return []
  }
  return values
}

function runnerLabels(job, where, report) {
  const runsOn = job['runs-on']
  if (runsOn === undefined) return []
  const declared = []
  if (typeof runsOn === 'string') declared.push(runsOn)
  else if (Array.isArray(runsOn)) declared.push(...runsOn)
  else {
    if (runsOn.group) report('hosted-runner', where, `group ${runsOn.group}`)
    declared.push(...[].concat(runsOn.labels ?? []))
  }
  return declared.flatMap((label) =>
    resolveRunnerLabel(label, job, where, report),
  )
}

export function inspectWorkflow({ file, text, data }) {
  const violations = []
  const report = (policy, where, detail) =>
    violations.push({
      policy,
      where: [file, where].filter(Boolean).join(' '),
      detail,
    })

  for (const name of new Set(secretNames(text))) {
    if (name.startsWith('[')) {
      report('secret-allowlist', '', `unresolved secrets${name}`)
      continue
    }
    const owners = secretOwners.get(name)
    if (!owners) report('secret-allowlist', '', `${name} is on no allowlist`)
    else if (!owners.includes(path.basename(file)))
      report('secret-allowlist', '', `${name} belongs to ${owners.join(', ')}`)
  }

  if (Object.keys(data.on ?? {}).includes('pull_request_target'))
    report('untrusted-trigger', '', 'pull_request_target')

  if (secretNames(JSON.stringify(data.env ?? {})).length > 0)
    report('secret-environment', 'workflow env', 'outside any environment')

  const workflowFile = path.basename(file)
  checkPermissions(data.permissions, '', report, {
    required: true,
    owner: { file: workflowFile },
  })
  const inheritsOidc = oidcLevel(data.permissions) === 'write'

  for (const [jobName, job] of Object.entries(data.jobs ?? {})) {
    const where = `job ${jobName}`
    checkPermissions(job.permissions, where, report, {
      required: false,
      owner: { file: workflowFile, job: jobName },
    })
    checkFailureVisibility(job, where, report)

    if (job['timeout-minutes'] === undefined)
      report('job-timeout', where, 'not declared')

    const grantsOidc =
      job.permissions === undefined
        ? inheritsOidc
        : oidcLevel(job.permissions) === 'write'
    if (grantsOidc && !publishesWithProvenance(job))
      report(
        'read-only-permissions',
        where,
        'id-token: write without a provenance publish',
      )

    for (const options of containerOptions(job))
      if (unisolatedContainer.test(options))
        report('container-isolation', where, options)

    for (const label of runnerLabels(job, where, report))
      if (!hostedRunner.test(label)) report('hosted-runner', where, label)

    const environment = environmentName(job)
    const used = [...new Set(secretNames(JSON.stringify(job)))]
    if (used.length > 0 && environment !== 'production')
      report('secret-environment', where, used.join(', '))

    if (job.uses) checkPin(job.uses, where, report)

    for (const [index, step] of (job.steps ?? []).entries()) {
      const stepWhere = `${where} step ${index}`
      if (step.uses) checkPin(step.uses, stepWhere, report)
      checkFailureVisibility(step, stepWhere, report)

      const persist = step.with?.['persist-credentials']
      if (step.uses?.startsWith('actions/checkout@') && persist !== false)
        report(
          'checkout-credentials',
          stepWhere,
          `persist-credentials: ${persist}`,
        )
      else if (persist !== undefined && persist !== false)
        report(
          'checkout-credentials',
          stepWhere,
          `persist-credentials: ${persist}`,
        )

      const delegated = step.with?.run_install
      if (
        step.uses?.startsWith('pnpm/action-setup@') &&
        delegated !== undefined &&
        delegated !== null &&
        delegated !== false
      )
        report(
          'install-scripts',
          stepWhere,
          `pnpm/action-setup run_install: ${JSON.stringify(delegated)}`,
        )

      for (const segment of commandSegments(step.run)) {
        const install = segment.match(installCommand)
        if (install) {
          if (!/--ignore-scripts\b/u.test(segment))
            report('install-scripts', stepWhere, segment.trim())
          else if (
            install[1] === 'pnpm' &&
            /\binstall\b/u.test(segment) &&
            !/--frozen-lockfile\b/u.test(segment)
          )
            report('install-scripts', stepWhere, segment.trim())
        }
        if (writesToProduction(segment) && environment !== 'production')
          report('production-write-environment', stepWhere, segment.trim())
        if (publishCommand.test(segment) && environment !== 'production')
          report('publish-environment', stepWhere, segment.trim())
      }
    }
  }

  return violations
}

export function summarize({ file, data }) {
  const counts = { file, jobs: 0, steps: 0, uses: 0, installs: 0, checkouts: 0 }
  for (const job of Object.values(data.jobs ?? {})) {
    counts.jobs += 1
    for (const step of job.steps ?? []) {
      counts.steps += 1
      if (step.uses) counts.uses += 1
      if (step.uses?.startsWith('actions/checkout@')) counts.checkouts += 1
      if (commandSegments(step.run).some((part) => installCommand.test(part)))
        counts.installs += 1
    }
  }
  return counts
}

function readWorkflows() {
  return fs
    .readdirSync(workflowDirectory)
    .filter((name) => /\.ya?ml$/u.test(name))
    .sort()
    .map((name) => {
      const file = path.join(workflowDirectory, name)
      const text = fs.readFileSync(file, 'utf8')
      const document = YAML.parseDocument(text)
      return { file, text, document, data: document.toJS() }
    })
}

const workflows = readWorkflows()
const violations = workflows.flatMap((workflow) => inspectWorkflow(workflow))

function offenders(policy) {
  return violations
    .filter((violation) => violation.policy === policy)
    .map((violation) => `${violation.where}: ${violation.detail}`)
}

test('the scan parses every workflow and reaches each one of them', () => {
  assert.ok(workflows.length > 0)
  assert.notEqual(YAML.parseDocument('jobs:\n\tbad: value').errors.length, 0)
  let installs = 0
  for (const workflow of workflows) {
    assert.deepEqual(workflow.document.errors, [], workflow.file)
    const counts = summarize(workflow)
    const detail = JSON.stringify(counts)
    assert.ok(counts.jobs > 0, detail)
    assert.ok(counts.steps > 0, detail)
    assert.ok(counts.uses > 0, detail)
    assert.ok(counts.checkouts > 0, detail)
    installs += counts.installs
  }
  assert.ok(installs > 0)
})

test('every secret is allowlisted and used only by the workflow that owns it', () => {
  assert.deepEqual(offenders('secret-allowlist'), [])
})

test('every job that reads a secret runs in the production environment', () => {
  assert.deepEqual(offenders('secret-environment'), [])
})

test('every production write runs in the production environment', () => {
  assert.deepEqual(offenders('production-write-environment'), [])
})

test('every package publish runs in the production environment', () => {
  assert.deepEqual(offenders('publish-environment'), [])
})

test('no workflow runs on an untrusted trigger', () => {
  assert.deepEqual(offenders('untrusted-trigger'), [])
})

test('every job runs on a GitHub-hosted runner', () => {
  assert.deepEqual(offenders('hosted-runner'), [])
})

test('every action is pinned to a full commit SHA', () => {
  assert.deepEqual(offenders('pinned-action'), [])
})

test('every dependency install refuses lockfile drift and install scripts', () => {
  assert.deepEqual(offenders('install-scripts'), [])
})

test('no checkout keeps credentials in the workspace', () => {
  assert.deepEqual(offenders('checkout-credentials'), [])
})

test('every permission stays read-only apart from OIDC tokens', () => {
  assert.deepEqual(offenders('read-only-permissions'), [])
})

test('no job or step hides its own failure', () => {
  assert.deepEqual(offenders('failure-visibility'), [])
})

test('no container escapes the runner sandbox', () => {
  assert.deepEqual(offenders('container-isolation'), [])
})

test('every job caps its own run time', () => {
  assert.deepEqual(offenders('job-timeout'), [])
})

const pin = `@${'a'.repeat(40)}`
const checkoutStep = {
  uses: `actions/checkout${pin}`,
  with: { 'persist-credentials': false },
}
const installStep = { run: 'pnpm install --frozen-lockfile --ignore-scripts' }

function withJob(overrides, name = 'check') {
  return {
    jobs: {
      [name]: {
        'runs-on': 'ubuntu-latest',
        'timeout-minutes': 10,
        steps: [checkoutStep, installStep],
        ...overrides,
      },
    },
  }
}

function policiesOf(overrides, file = 'fixture.yml') {
  const data = {
    on: { push: { branches: ['main'] } },
    permissions: { contents: 'read' },
    ...withJob({}),
    ...overrides,
  }
  const found = inspectWorkflow({ file, text: YAML.stringify(data), data })
  return [...new Set(found.map((violation) => violation.policy))].sort()
}

const secretStep = (name) => ({
  run: 'node scripts/probe.mjs',
  env: { TOKEN: `\${{ secrets.${name} }}` },
})

const publishStep = {
  run: 'npm publish --access public --provenance',
}

for (const [name, overrides, expected, file] of [
  ['accepts a compliant workflow', {}, []],
  [
    'rejects a job that declares no timeout',
    {
      jobs: {
        check: {
          'runs-on': 'ubuntu-latest',
          steps: [checkoutStep, installStep],
        },
      },
    },
    ['job-timeout'],
  ],
  [
    'accepts an OIDC token in the job that publishes with provenance',
    {
      permissions: { contents: 'read', 'id-token': 'write' },
      ...withJob({
        environment: 'production',
        steps: [checkoutStep, installStep, publishStep],
      }),
    },
    [],
  ],
  [
    'rejects an OIDC token in a job that publishes nothing',
    { permissions: { contents: 'read', 'id-token': 'write' } },
    ['read-only-permissions'],
  ],
  [
    'rejects an OIDC token granted to one job that publishes nothing',
    withJob({ permissions: { contents: 'read', 'id-token': 'write' } }),
    ['read-only-permissions'],
  ],
  [
    'accepts a production write inside the environment',
    withJob({
      environment: 'production',
      steps: [checkoutStep, { run: 'pnpm exec wrangler deploy' }],
    }),
    [],
  ],
  [
    'accepts a read-only Wrangler command',
    withJob({ steps: [checkoutStep, { run: 'pnpm exec wrangler whoami' }] }),
    [],
  ],
  [
    'accepts a Wrangler dry run',
    withJob({
      steps: [
        checkoutStep,
        { run: 'pnpm exec wrangler deploy -c w.jsonc --dry-run' },
      ],
    }),
    [],
  ],
  [
    'rejects a secret outside the allowlist',
    withJob({
      environment: 'production',
      steps: [checkoutStep, secretStep('MYSTERY_TOKEN')],
    }),
    ['secret-allowlist'],
  ],
  [
    'rejects a secret the bracket form hides',
    withJob({
      environment: 'production',
      steps: [
        checkoutStep,
        {
          run: 'node scripts/probe.mjs',
          env: { TOKEN: "${{ secrets['MYSTERY_TOKEN'] }}" },
        },
      ],
    }),
    ['secret-allowlist'],
  ],
  [
    'rejects a secret another workflow owns',
    withJob({
      environment: 'production',
      steps: [checkoutStep, secretStep('CLOUDFLARE_API_TOKEN')],
    }),
    ['secret-allowlist'],
    'release-qm-bridge.yml',
  ],
  [
    'rejects a secret outside the production environment',
    withJob({ steps: [checkoutStep, secretStep('CLOUDFLARE_API_TOKEN')] }),
    ['secret-environment'],
    'deploy-production.yml',
  ],
  [
    'rejects a Wrangler command that is not read-only',
    withJob({
      steps: [checkoutStep, { run: 'pnpm exec wrangler kv key put a b' }],
    }),
    ['production-write-environment'],
  ],
  [
    'rejects a production write outside the environment',
    withJob({ steps: [checkoutStep, { run: 'pnpm exec wrangler deploy' }] }),
    ['production-write-environment'],
  ],
  [
    'rejects a remote database write outside the environment',
    withJob({
      steps: [checkoutStep, { run: 'pnpm db:apply:remote:production' }],
    }),
    ['production-write-environment'],
  ],
  [
    'rejects the pull_request_target trigger',
    { on: { pull_request_target: { branches: ['main'] } } },
    ['untrusted-trigger'],
  ],
  [
    'rejects a self-hosted runner',
    withJob({ 'runs-on': 'self-hosted' }),
    ['hosted-runner'],
  ],
  [
    'rejects a runner label that only looks hosted',
    withJob({ 'runs-on': 'ubuntu-internal' }),
    ['hosted-runner'],
  ],
  [
    'accepts a dated hosted runner image',
    withJob({ 'runs-on': 'ubuntu-24.04' }),
    [],
  ],
  [
    'rejects a self-hosted runner group',
    withJob({ 'runs-on': { group: 'internal', labels: ['ubuntu-latest'] } }),
    ['hosted-runner'],
  ],
  [
    'rejects a runner label it cannot resolve',
    withJob({ 'runs-on': '${{ matrix.os }}' }),
    ['hosted-runner'],
  ],
  [
    'accepts a matrix of hosted runners',
    withJob({
      'runs-on': '${{ matrix.os }}',
      strategy: { matrix: { os: ['ubuntu-latest', 'windows-latest'] } },
    }),
    [],
  ],
  [
    'rejects a self-hosted runner reached through a matrix',
    withJob({
      'runs-on': '${{ matrix.os }}',
      strategy: { matrix: { os: ['ubuntu-latest', 'self-hosted'] } },
    }),
    ['hosted-runner'],
  ],
  [
    'rejects an action pinned to a tag',
    withJob({
      steps: [
        { uses: 'actions/checkout@v7', with: { 'persist-credentials': false } },
      ],
    }),
    ['pinned-action'],
  ],
  [
    'rejects an action pinned to a short SHA',
    withJob({
      steps: [
        {
          uses: `actions/checkout@${'a'.repeat(7)}`,
          with: { 'persist-credentials': false },
        },
      ],
    }),
    ['pinned-action'],
  ],
  [
    'rejects an install that runs scripts',
    withJob({
      steps: [checkoutStep, { run: 'pnpm install --frozen-lockfile' }],
    }),
    ['install-scripts'],
  ],
  [
    'rejects an install that accepts lockfile drift',
    withJob({
      steps: [checkoutStep, { run: 'pnpm install --ignore-scripts' }],
    }),
    ['install-scripts'],
  ],
  [
    'rejects a packed install that runs scripts',
    withJob({
      steps: [
        checkoutStep,
        installStep,
        { run: 'npm install "$TGZ" --no-save' },
      ],
    }),
    ['install-scripts'],
  ],
  [
    'rejects an install hidden behind a chained command',
    withJob({
      steps: [
        checkoutStep,
        { run: 'corepack enable && pnpm install --frozen-lockfile' },
      ],
    }),
    ['install-scripts'],
  ],
  [
    'rejects an install delegated to the pnpm action',
    withJob({
      steps: [
        { uses: `pnpm/action-setup${pin}`, with: { run_install: true } },
        installStep,
      ],
    }),
    ['install-scripts'],
  ],
  [
    'rejects a checkout that keeps credentials',
    withJob({ steps: [{ uses: `actions/checkout${pin}` }, installStep] }),
    ['checkout-credentials'],
  ],
  [
    'rejects a checkout that persists credentials on purpose',
    withJob({
      steps: [
        {
          uses: `actions/checkout${pin}`,
          with: { 'persist-credentials': true },
        },
        installStep,
      ],
    }),
    ['checkout-credentials'],
  ],
  [
    'rejects undeclared permissions',
    { permissions: undefined },
    ['read-only-permissions'],
  ],
  [
    'rejects a write permission',
    { permissions: { contents: 'read', 'pull-requests': 'write' } },
    ['read-only-permissions'],
  ],
  [
    'rejects blanket write permissions',
    { permissions: 'write-all' },
    ['read-only-permissions'],
  ],
  [
    'rejects a write permission on a job',
    withJob({ permissions: { contents: 'write' } }),
    ['read-only-permissions'],
  ],
  [
    'accepts a writable scope in the job that owns it',
    withJob({ permissions: { contents: 'read', issues: 'write' } }, 'report'),
    [],
    'flaky-detector.yml',
  ],
  [
    'rejects a writable scope in another job of the owning workflow',
    withJob({ permissions: { contents: 'read', issues: 'write' } }),
    ['read-only-permissions'],
    'flaky-detector.yml',
  ],
  [
    'rejects a writable scope the owning workflow grants to every job',
    {
      permissions: { contents: 'read', issues: 'write' },
      ...withJob({}, 'report'),
    },
    ['read-only-permissions'],
    'flaky-detector.yml',
  ],
  [
    'rejects a writable scope in a workflow that does not own it',
    withJob({ permissions: { contents: 'read', issues: 'write' } }, 'report'),
    ['read-only-permissions'],
  ],
  [
    'accepts a browser container with shared memory',
    withJob({
      container: { image: 'example', options: '--init --ipc=host' },
    }),
    [],
  ],
  [
    'accepts a tolerated artifact download',
    withJob({
      steps: [
        {
          uses: `actions/download-artifact${pin}`,
          'continue-on-error': true,
        },
      ],
    }),
    [],
  ],
  [
    'rejects a job that hides its failure',
    withJob({ 'continue-on-error': true }),
    ['failure-visibility'],
  ],
  [
    'rejects a step that hides its failure',
    withJob({
      steps: [checkoutStep, { ...installStep, 'continue-on-error': true }],
    }),
    ['failure-visibility'],
  ],
  [
    'rejects a privileged container',
    withJob({ container: { image: 'example', options: '--privileged' } }),
    ['container-isolation'],
  ],
  [
    'rejects a container on the host network',
    withJob({
      container: { image: 'example', options: '--init --network=host' },
    }),
    ['container-isolation'],
  ],
  [
    'rejects a service with the docker socket mounted',
    withJob({
      services: {
        helper: { image: 'example', options: '-v /var/run/docker.sock:/x' },
      },
    }),
    ['container-isolation'],
  ],
  [
    'rejects a publish outside the production environment',
    withJob({ steps: [checkoutStep, installStep, publishStep] }),
    ['publish-environment'],
  ],
  [
    'rejects a publish a workspace filter hides',
    withJob({
      steps: [
        checkoutStep,
        installStep,
        { run: 'pnpm --filter @artifactshare/cli publish --provenance' },
      ],
    }),
    ['publish-environment'],
  ],
  [
    'rejects a publish reached through a package script',
    withJob({ steps: [checkoutStep, installStep, { run: 'npm run publish' }] }),
    ['publish-environment'],
  ],
  [
    'accepts a publish inside the production environment',
    withJob({
      environment: 'production',
      steps: [checkoutStep, installStep, publishStep],
    }),
    [],
  ],
  [
    'rejects an OIDC token whose only publish is printed text',
    {
      permissions: { contents: 'read', 'id-token': 'write' },
      ...withJob({
        environment: 'production',
        steps: [
          checkoutStep,
          installStep,
          { run: 'echo "npm publish --access public --provenance"' },
        ],
      }),
    },
    ['read-only-permissions'],
  ],
  [
    'rejects a secret index it cannot resolve',
    withJob({
      environment: 'production',
      steps: [
        checkoutStep,
        {
          run: 'node scripts/probe.mjs',
          env: { TOKEN: '${{ secrets[env.NAME] }}' },
        },
      ],
    }),
    ['secret-allowlist'],
  ],
  [
    'rejects an unresolved secret index outside the production environment',
    withJob({
      steps: [
        checkoutStep,
        {
          run: 'node scripts/probe.mjs',
          env: { TOKEN: "${{ secrets[format('NPM_{0}', inputs.name)] }}" },
        },
      ],
    }),
    ['secret-allowlist', 'secret-environment'],
  ],
]) {
  test(`policy scan ${name}`, () => {
    assert.deepEqual(policiesOf(overrides, file), expected)
  })
}
