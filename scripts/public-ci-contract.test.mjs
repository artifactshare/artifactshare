import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import YAML from 'yaml'
import { PROJECTS as repeatedProjects } from './ci/changed-browser-repetitions.mjs'
import { lanes as nightlyLanes } from './ci/flaky-runs.mjs'

const workflowPath = '.github/workflows/public-ci.yml'
const workflow = fs.readFileSync(workflowPath, 'utf8')
const parsedWorkflow = YAML.parse(workflow)
const visualConfig = fs.readFileSync(
  'apps/web/vitest.visual.browser.config.ts',
  'utf8',
)
const visualCompose = fs.readFileSync('compose.playwright.yml', 'utf8')
const previewWrangler = fs.readFileSync('apps/web/wrangler.jsonc', 'utf8')

const publicPackagePaths = [
  'package.json',
  'apps/web/package.json',
  'packages/cli/package.json',
  'packages/qm-bridge/package.json',
  'packages/npm-reserved/package.json',
  'tools/static-site-fixtures/package.json',
]

const productionCommands = new Map([
  [
    'apps/web/package.json#deploy:production',
    'pnpm build:production:topology && pnpm deploy:production:built',
  ],
  [
    'apps/web/package.json#deploy:production:built',
    'pnpm db:apply:remote:production && WRANGLER_LOG_PATH=../../.wrangler/logs pnpm exec wrangler deploy -c wrangler.alerts.jsonc --env production && WRANGLER_LOG_PATH=../../.wrangler/logs pnpm exec wrangler deploy -c wrangler.og-image.jsonc --env production && node ../../scripts/deploy-content-cutover.mjs',
  ],
])

export function assertPublicPackageScriptsAreSafe(packages) {
  for (const [packagePath, packageJson] of packages)
    for (const [name, command] of Object.entries(packageJson.scripts ?? {})) {
      const label = `${packagePath}#${name}`
      if (productionCommands.has(label)) {
        assert.equal(command, productionCommands.get(label), label)
        continue
      }
      assert.doesNotMatch(
        command,
        /pull_request_target|self-hosted|secrets\./i,
        label,
      )
      for (const segment of command.split(/&&|\|\||;/u)) {
        assert.doesNotMatch(segment, /\bwrangler\s+secret\b/i, label)
        assert.doesNotMatch(
          segment,
          /\bpnpm\s+(?!exec\b)[^&;|]*\b(?:deploy|publish)\b/i,
          label,
        )
        assert.doesNotMatch(segment, /\bnpm\s+publish\b/i, label)
        if (/\bwrangler\s+deploy\b/i.test(segment))
          assert.match(segment, /(?:^|\s)--dry-run(?:\s|$)/u, label)
      }
    }
}

test('public preview configuration has no remote Flagship binding', () => {
  assert.doesNotMatch(previewWrangler, /["']flagship["']\s*:/u)
})

const sameRepositoryGate =
  /steps\.classify\.outputs\.(?:is_maintainer|run_static|run_models) == 'true'/u

function reachableFromPullRequests(job) {
  return job.if === undefined || /pull_request\b/u.test(job.if)
}

function executesRepositoryCode(step) {
  if (typeof step.run !== 'string') return false
  return step.run
    .split('\n')
    .filter((line) => /(?:^|\s)(?:pnpm|npx|node)\s/u.test(line))
    .some((line) => !/\bnode -e\b/u.test(line) && !/\btrusted\//u.test(line))
}

test('no job runs pull request code without same-repository classification', () => {
  const gated = []
  for (const [name, job] of Object.entries(parsedWorkflow.jobs)) {
    if (!reachableFromPullRequests(job)) continue
    for (const step of (job.steps ?? []).filter(executesRepositoryCode)) {
      assert.match(
        step.if ?? '',
        sameRepositoryGate,
        `${name}: ${step.name ?? step.run}`,
      )
      gated.push(name)
    }
  }
  assert.ok(gated.length > 0)
})

test('the pull request boundary runs trusted code over the head checkout', () => {
  const guard = parsedWorkflow.jobs['pull-request-guard']
  const checkouts = guard.steps.filter((step) =>
    step.uses?.startsWith('actions/checkout@'),
  )
  const trusted = checkouts.find((step) => step.with.path === 'trusted')
  const head = checkouts.find((step) => step.with.path === 'head')
  assert.equal(trusted.with.ref, '${{ github.event.pull_request.base.ref }}')
  assert.equal(head.with.ref, '${{ github.event.pull_request.head.sha }}')

  const boundary = guard.steps.find((step) =>
    step.run?.includes('public-development-guard.mjs'),
  )
  for (const literal of [
    'node trusted/scripts/public-development-guard.mjs --ci-pr',
    '--repo "$GITHUB_WORKSPACE/head"',
    '--manifest-repo "$GITHUB_WORKSPACE/trusted"',
    '--metadata-file "$RUNNER_TEMP/public-pr-title.txt"',
    '--metadata-file "$RUNNER_TEMP/public-pr-body.txt"',
  ])
    assert.ok(boundary.run.includes(literal), literal)
  assert.equal(
    boundary.env.PUBLIC_PR_TITLE,
    '${{ github.event.pull_request.title }}',
  )
  assert.equal(
    boundary.env.PUBLIC_PR_BODY,
    '${{ github.event.pull_request.body }}',
  )
  assert.doesNotMatch(boundary.run, /\$\{\{/u)
})

test('PR classification matches the trusted guard predicate', () => {
  const guard = parsedWorkflow.jobs['pull-request-guard']
  const classify = guard.steps[1]
  const guardSource = fs.readFileSync(
    'scripts/public-development-guard.mjs',
    'utf8',
  )
  const predicate =
    "headRepoFullName !== '' && headRepoFullName === baseRepoFullName"
  const normalize = (value) => value.replace(/\s+/gu, ' ')
  assert.equal(
    (normalize(classify.run).match(new RegExp(predicate, 'gu')) ?? []).length,
    1,
  )
  assert.equal(
    (normalize(guardSource).match(new RegExp(predicate, 'gu')) ?? []).length,
    1,
  )
  assert.equal(
    classify.env.PUBLIC_PR_HEAD_REPO,
    '${{ github.event.pull_request.head.repo.full_name }}',
  )
  assert.equal(
    classify.env.PUBLIC_PR_BASE_REPO,
    '${{ github.event.pull_request.base.repo.full_name }}',
  )
  assert.match(classify.run, /^node -e "[^"`]+"\n$/u)
  assert.doesNotMatch(classify.run, /\$|`/u)
  assert.match(classify.run, /process\.env\.PUBLIC_PR_HEAD_REPO \?\? ''/u)
  assert.match(classify.run, /process\.env\.PUBLIC_PR_BASE_REPO \?\? ''/u)
  assert.match(
    classify.run,
    /fs\.appendFileSync\(process\.env\.GITHUB_OUTPUT,/u,
  )

  const script = classify.run.trim().match(/^node -e "(.*)"$/u)?.[1]
  assert.ok(script)
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'public-ci-classify-'),
  )
  try {
    for (const [headRepo, baseRepo, expected] of [
      ['owner/repo', 'owner/repo', 'true'],
      ['fork/repo', 'owner/repo', 'false'],
      ['Owner/Repo', 'owner/repo', 'false'],
      ['', 'owner/repo', 'false'],
    ]) {
      const output = path.join(directory, `${expected}-${headRepo.length}.txt`)
      fs.writeFileSync(output, 'seed\n')
      const result = spawnSync('node', ['-e', script], {
        encoding: 'utf8',
        env: {
          ...process.env,
          GITHUB_OUTPUT: output,
          PUBLIC_PR_HEAD_REPO: headRepo,
          PUBLIC_PR_BASE_REPO: baseRepo,
        },
      })
      assert.equal(result.status, 0, result.stderr)
      assert.equal(
        fs.readFileSync(output, 'utf8'),
        `seed\nis_maintainer=${expected}\n`,
      )
    }
    const failed = spawnSync('node', ['-e', script], {
      encoding: 'utf8',
      env: {
        ...process.env,
        GITHUB_OUTPUT: directory,
        PUBLIC_PR_HEAD_REPO: 'owner/repo',
        PUBLIC_PR_BASE_REPO: 'owner/repo',
      },
    })
    assert.notEqual(failed.status, 0)
  } finally {
    fs.rmSync(directory, { recursive: true })
  }
})

test('PR summaries are static, distinct per outcome, and fail closed', () => {
  const summary = parsedWorkflow.jobs['pull-request-guard'].steps[5]
  assert.equal(summary.if, '${{ !cancelled() }}')
  assert.deepEqual(summary.env, {
    IS_MAINTAINER: '${{ steps.classify.outputs.is_maintainer }}',
    BOUNDARY_OUTCOME: '${{ steps.boundary.outcome }}',
  })
  assert.equal((JSON.stringify(summary).match(/\$\{\{/gu) ?? []).length, 3)
  assert.ok(summary.run.startsWith('set -euo pipefail\n'))
  assert.match(summary.run, /"\$IS_MAINTAINER"/u)
  assert.match(summary.run, /"\$BOUNDARY_OUTCOME"/u)
  assert.doesNotMatch(summary.run, /\$\{\{|\$\(|`|\|/u)
  const syntax = spawnSync('bash', ['-n'], {
    encoding: 'utf8',
    input: summary.run,
  })
  assert.equal(syntax.status, 0, syntax.stderr)

  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'public-ci-summary-'))
  const render = (isMaintainer, outcome) => {
    const output = path.join(directory, `${isMaintainer}-${outcome}.md`)
    const result = spawnSync('bash', ['-c', summary.run], {
      encoding: 'utf8',
      env: {
        ...process.env,
        IS_MAINTAINER: isMaintainer,
        BOUNDARY_OUTCOME: outcome,
        GITHUB_STEP_SUMMARY: output,
      },
    })
    assert.equal(result.status, 0, result.stderr)
    return fs.readFileSync(output, 'utf8')
  }
  try {
    const outcomes = ['success', 'failure', 'skipped']
    const maintainer = outcomes.map((outcome) => render('true', outcome))
    const fork = outcomes.map((outcome) => render('false', outcome))
    assert.equal(new Set([...maintainer, ...fork]).size, 6)
    assert.equal(render('unexpected', 'success'), fork[0])
    assert.equal(render('false', 'unexpected'), fork[2])
    const failed = spawnSync('bash', ['-c', summary.run], {
      encoding: 'utf8',
      env: {
        ...process.env,
        IS_MAINTAINER: 'false',
        BOUNDARY_OUTCOME: 'success',
        GITHUB_STEP_SUMMARY: directory,
      },
    })
    assert.notEqual(failed.status, 0)
  } finally {
    fs.rmSync(directory, { recursive: true })
  }
})

const aggregateResultVariables = {
  'static-validation': 'STATIC_RESULT',
  'model-validation': 'MODEL_RESULT',
  'build-validation': 'BUILD_RESULT',
  'cli-validation': 'CLI_RESULT',
  'windows-cli-validation': 'WINDOWS_CLI_RESULT',
  'upload-boundary-validation': 'UPLOAD_BOUNDARY_RESULT',
  'browser-validation': 'BROWSER_RESULT',
  'visual-validation': 'VISUAL_RESULT',
}

function runAggregate(eventName, results) {
  const [step] = parsedWorkflow.jobs.validate.steps
  return spawnSync('bash', ['-c', step.run], {
    encoding: 'utf8',
    env: { ...process.env, EVENT_NAME: eventName, ...results },
  })
}

const pullRequestLanes = new Set(['STATIC_RESULT', 'MODEL_RESULT'])

function aggregateResults(staticResult, otherResult) {
  return Object.fromEntries(
    Object.values(aggregateResultVariables).map((name) => [
      name,
      pullRequestLanes.has(name) ? staticResult : otherResult,
    ]),
  )
}

test('pull request aggregate requires static and model success with other lanes skipped', () => {
  const healthy = runAggregate(
    'pull_request',
    aggregateResults('success', 'skipped'),
  )
  assert.equal(healthy.status, 0, healthy.stderr)
  for (const name of pullRequestLanes)
    for (const laneResult of ['failure', 'cancelled', 'skipped', '']) {
      const result = runAggregate('pull_request', {
        ...aggregateResults('success', 'skipped'),
        [name]: laneResult,
      })
      assert.notEqual(result.status, 0, `${name}=${laneResult}`)
    }
  // A lane that ran on a pull request is unexpected, whatever its result.
  for (const otherResult of ['success', 'failure', 'cancelled', '']) {
    const result = runAggregate(
      'pull_request',
      aggregateResults('success', otherResult),
    )
    assert.notEqual(result.status, 0, `other=${otherResult}`)
  }
})

test('merge group aggregate requires every lane to succeed', () => {
  const healthy = runAggregate(
    'merge_group',
    aggregateResults('success', 'success'),
  )
  assert.equal(healthy.status, 0, healthy.stderr)
  for (const name of Object.values(aggregateResultVariables)) {
    for (const laneResult of ['failure', 'cancelled', 'skipped', '']) {
      const result = runAggregate('merge_group', {
        ...aggregateResults('success', 'success'),
        [name]: laneResult,
      })
      assert.notEqual(result.status, 0, `${name}=${laneResult}`)
    }
  }
  const dispatch = runAggregate(
    'workflow_dispatch',
    aggregateResults('success', 'success'),
  )
  assert.notEqual(dispatch.status, 0)
})

for (const [lane, decision] of [
  ['static-validation', 'run_static'],
  ['model-validation', 'run_models'],
])
  test(`${lane} runs code only for same-repository pull requests`, () => {
    const classify = parsedWorkflow.jobs[lane].steps[0]
    const decide = (event, head, base) => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'static-classify-'))
      const output = path.join(dir, 'output')
      fs.writeFileSync(output, '')
      const run = spawnSync('bash', ['-c', classify.run], {
        env: {
          ...process.env,
          GITHUB_OUTPUT: output,
          EVENT_NAME: event,
          PUBLIC_PR_HEAD_REPO: head,
          PUBLIC_PR_BASE_REPO: base,
        },
      })
      assert.equal(run.status, 0)
      const result = fs.readFileSync(output, 'utf8').trim()
      fs.rmSync(dir, { recursive: true, force: true })
      return result
    }
    const repo = 'artifactshare/artifactshare'
    assert.equal(decide('pull_request', repo, repo), `${decision}=true`)
    assert.equal(
      decide('pull_request', 'someone/fork', repo),
      `${decision}=false`,
    )
    assert.equal(decide('pull_request', '', repo), `${decision}=false`)
    assert.equal(decide('merge_group', '', ''), `${decision}=true`)
  })

test('static, CLI, and build lanes preserve complete nonvisual coverage', () => {
  const rootPackage = JSON.parse(fs.readFileSync('package.json', 'utf8'))
  const staticRuns = parsedWorkflow.jobs['static-validation'].steps
    .map((step) => step.run ?? '')
    .join('\n')
  const buildRuns = parsedWorkflow.jobs['build-validation'].steps
    .map((step) => step.run ?? '')
    .join('\n')
  const cliRuns = parsedWorkflow.jobs['cli-validation'].steps
    .map((step) => step.run ?? '')
    .join('\n')
  assert.match(staticRuns, /pnpm validate:static/u)
  assert.doesNotMatch(staticRuns, /pnpm fixtures:build/u)
  assert.equal(
    (rootPackage.scripts.test.match(/pnpm fixtures:build/gu) ?? []).length,
    1,
  )
  assert.equal(
    (
      rootPackage.scripts['test:unit:noncli'].match(/pnpm fixtures:build/gu) ??
      []
    ).length,
    1,
  )
  const validationRuns = Object.values(parsedWorkflow.jobs)
    .flatMap((job) => job.steps ?? [])
    .map((step) => step.run ?? '')
    .join('\n')
  assert.equal((validationRuns.match(/pnpm fixtures:build/gu) ?? []).length, 1)
  assert.doesNotMatch(buildRuns, /pnpm fixtures:build/u)
  assert.match(buildRuns, /pnpm db:apply:local/u)
  assert.match(buildRuns, /pnpm check:dev-setup/u)
  assert.match(buildRuns, /pnpm validate:build/u)
  assert.match(rootPackage.scripts['validate:static'], /pnpm test:unit:noncli/u)
  assert.match(
    rootPackage.scripts['validate:static'],
    /pnpm check:dependency-overrides && pnpm test:d1/u,
  )
  assert.equal(
    rootPackage.scripts['test:d1'],
    'pnpm --filter @artifactshare/web test:d1',
  )
  assert.doesNotMatch(
    rootPackage.scripts['validate:static'],
    /artifactshare\/cli/u,
  )
  assert.match(rootPackage.scripts['validate:static'], /pnpm check:doctor/u)
  assert.match(cliRuns, /pnpm validate:cli/u)
  // The CLI reference check runs once, in the static lane.
  assert.match(
    rootPackage.scripts['validate:static'],
    /pnpm check:contract-surfaces/u,
  )
  assert.equal(
    rootPackage.scripts['validate:cli'],
    'pnpm --filter @artifactshare/cli test && pnpm --filter @artifactshare/cli test:package',
  )
  assert.match(rootPackage.scripts['validate:build'], /pnpm build/u)
  assert.match(rootPackage.scripts['validate:build'], /integration:test:run/u)
  assert.match(rootPackage.scripts['validate:build'], /pnpm test:runtime/u)
  assert.equal(
    rootPackage.scripts['validate:nonvisual'],
    'pnpm validate:static && pnpm validate:cli && pnpm test:behavior-browser && pnpm validate:build',
  )
})

test('pnpm lint runs the agent pattern ratchet against the pull request or merge group base', () => {
  const rootPackage = JSON.parse(fs.readFileSync('package.json', 'utf8'))
  assert.match(
    rootPackage.scripts.lint,
    /&& node scripts\/agent-pattern-ratchet\.mjs$/u,
  )
  assert.match(rootPackage.scripts['validate:static'], /&& pnpm lint &&/u)
  const steps = parsedWorkflow.jobs['static-validation'].steps
  const validate = steps.find((step) =>
    /pnpm validate:static/u.test(step.run ?? ''),
  )
  assert.equal(
    validate.env?.AGENT_RATCHET_BASE,
    '${{ github.event.pull_request.base.sha || github.event.merge_group.base_sha }}',
  )
  const checkout = steps.find((step) =>
    step.uses?.startsWith('actions/checkout@'),
  )
  assert.equal(checkout.with['fetch-depth'], 0)
})

function laneRunning(pattern) {
  const owners = Object.entries(parsedWorkflow.jobs).filter(([, job]) =>
    (job.steps ?? []).some((step) => pattern.test(step.run ?? '')),
  )
  assert.equal(owners.length, 1, String(pattern))
  return owners[0][0]
}

test('every merge gate lane keeps the validation only it runs', () => {
  for (const command of [
    /pnpm validate:static/u,
    /pnpm validate:build/u,
    /pnpm validate:cli/u,
    /node --run check:access-model/u,
    /node --run check:billing-model/u,
    /node --run check:cli-refresh-model/u,
    /pnpm test:behavior-browser/u,
    /pnpm check:browser-local-state/u,
    /node --test scripts\/browser-waits\.integration\.mjs/u,
    /vitest run src\/token-store\.test\.ts/u,
    /vitest run src\/upload-boundary\.test\.ts src\/upload-boundary-commands\.test\.ts/u,
    /docker compose -f compose\.playwright\.yml run --rm visual/u,
  ]) {
    const lane = laneRunning(command)
    assert.ok(
      parsedWorkflow.jobs.validate.needs.includes(lane),
      `${command} runs in ${lane}, which the aggregate does not require`,
    )
  }
  const root = JSON.parse(fs.readFileSync('package.json', 'utf8'))
  assert.doesNotMatch(root.scripts['test:scripts'], /integration/)
})

test('every merge gate lane checks out the code under test', () => {
  const eventHeads = new Set([
    '${{ github.sha }}',
    "${{ github.event_name == 'pull_request' && github.event.pull_request.head.sha || github.sha }}",
  ])
  for (const name of parsedWorkflow.jobs.validate.needs) {
    const checkouts = (parsedWorkflow.jobs[name].steps ?? []).filter((step) =>
      step.uses?.startsWith('actions/checkout@'),
    )
    assert.ok(checkouts.length > 0, name)
    for (const checkout of checkouts)
      assert.ok(
        eventHeads.has(checkout.with.ref),
        `${name}: ${checkout.with.ref}`,
      )
  }
})

test('pull requests and the merge queue leave Firefox to the nightly detector', () => {
  const mergeQueue = new Set(
    parsedWorkflow.jobs['browser-validation'].strategy.matrix.include.map(
      ({ project }) => project,
    ),
  )
  assert.deepEqual([...mergeQueue].sort(), ['chromium', 'webkit'])
  assert.deepEqual(
    parsedWorkflow.jobs['changed-browser-repetitions'].strategy.matrix.project,
    repeatedProjects,
  )
  assert.deepEqual(repeatedProjects, ['chromium', 'webkit'])
  assert.ok(
    nightlyLanes.some(
      ({ suite, project }) =>
        suite === 'behavior-browser' && project === 'firefox',
    ),
  )
})

test('the browser matrix covers every shard of every project', () => {
  const entries =
    parsedWorkflow.jobs['browser-validation'].strategy.matrix.include
  assert.ok(entries.length > 0)
  const byProject = new Map()
  for (const { project, shard, total } of entries) {
    const seen = byProject.get(project) ?? { total, shards: new Set() }
    assert.equal(seen.total, total, project)
    seen.shards.add(shard)
    byProject.set(project, seen)
  }
  for (const [project, { total, shards }] of byProject)
    assert.deepEqual(
      [...shards].sort((left, right) => left - right),
      Array.from({ length: total }, (_, index) => index + 1),
      project,
    )
})

test('required browser repetition check rejects failed, cancelled or missing matrix results', () => {
  const job = parsedWorkflow.jobs['changed-browser-repetitions-result']
  const [step] = job.steps
  assert.equal(
    step.env.BROWSER_RESULT,
    '${{ needs.changed-browser-repetitions.result }}',
  )
  for (const status of ['success', 'failure', 'cancelled', 'skipped', '']) {
    const result = spawnSync('bash', ['-eu', '-c', step.run], {
      env: { ...process.env, BROWSER_RESULT: status },
    })
    assert.equal(result.status, status === 'success' ? 0 : 1, status)
  }
})

for (const name of [
  'changed-browser-repetitions',
  'chromium-source-feedback',
]) {
  test(`${name} classification rejects forks, case differences, and missing names before checkout`, (t) => {
    const lane = parsedWorkflow.jobs[name]
    const script = lane.steps[1].run.trim().match(/^node -e "(.*)"$/u)[1]
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), 'changed-classify-'),
    )
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
    for (const [head, base, expected] of [
      ['owner/repo', 'owner/repo', true],
      ['fork/repo', 'owner/repo', false],
      ['Owner/repo', 'owner/repo', false],
      ['', 'owner/repo', false],
      ['owner/repo', '', false],
      [undefined, 'owner/repo', false],
      ['owner/repo', undefined, false],
      [undefined, undefined, false],
      ['', '', false],
    ]) {
      const output = path.join(directory, 'output')
      fs.writeFileSync(output, '')
      const env = { ...process.env, GITHUB_OUTPUT: output }
      delete env.PUBLIC_PR_HEAD_REPO
      delete env.PUBLIC_PR_BASE_REPO
      if (head !== undefined) env.PUBLIC_PR_HEAD_REPO = head
      if (base !== undefined) env.PUBLIC_PR_BASE_REPO = base
      const result = spawnSync(process.execPath, ['-e', script], {
        env,
        encoding: 'utf8',
      })
      assert.equal(result.status, 0, result.stderr)
      assert.equal(
        fs.readFileSync(output, 'utf8'),
        `is_maintainer=${expected}\n`,
      )
    }
  })
}

test('visual gate uses exact Linux Compose baselines', () => {
  assert.doesNotMatch(visualConfig, /allowedMismatchedPixelRatio/u)
  assert.match(visualConfig, /VISUAL_FAULT/u)
  assert.deepEqual(YAML.parseDocument(visualCompose).errors, [])
  assert.match(visualCompose, /platform: linux\/amd64/u)
  assert.match(
    visualCompose,
    /mcr\.microsoft\.com\/playwright:[^\s]+@sha256:[0-9a-f]{64}/u,
  )
  assert.match(visualCompose, /CI: 'true'/u)
  assert.match(visualCompose, /--frozen-lockfile --ignore-scripts/u)
  assert.match(
    visualCompose,
    /vitest\.visual\.browser\.config\.ts --run --update/u,
  )
  const webPackage = JSON.parse(
    fs.readFileSync('apps/web/package.json', 'utf8'),
  )
  assert.equal(webPackage.devDependencies.playwright, '1.64.0')
  const compose = YAML.parse(visualCompose, { merge: true })
  assert.deepEqual(Object.keys(compose.services), ['visual', 'visual-update'])
  for (const service of Object.values(compose.services)) {
    assert.equal(
      service.image,
      `mcr.microsoft.com/playwright:v${webPackage.devDependencies.playwright}-noble@sha256:06a9939e57531807f8d5fd76ce44b53165ffb7d7501d87ab10e285c20b1e971f`,
    )
    assert.equal(service.platform, 'linux/amd64')
    assert.equal(service.ipc, 'host')
    assert.equal(service.working_dir, '/workspace')
    assert.deepEqual(service.entrypoint, ['bash', '-lc'])
    assert.deepEqual(service.environment, {
      CI: 'true',
      PLAYWRIGHT_BROWSERS_PATH: '/ms-playwright',
      VISUAL_FAULT: '${VISUAL_FAULT:-}',
      VITEST_TEST_NAME: '${VITEST_TEST_NAME:-}',
    })
    assert.deepEqual(service.volumes, [
      { type: 'bind', source: '.', target: '/workspace' },
      ...[
        ['playwright-pnpm-store', '/pnpm/store'],
        ['playwright-root-node-modules', '/workspace/node_modules'],
        ['playwright-web-node-modules', '/workspace/apps/web/node_modules'],
        ['playwright-cli-node-modules', '/workspace/packages/cli/node_modules'],
        [
          'playwright-fixtures-node-modules',
          '/workspace/tools/static-site-fixtures/node_modules',
        ],
      ].map(([source, target]) => ({ type: 'volume', source, target })),
    ])
    assert.deepEqual(service.command, [
      'npm install --global --prefix /opt/toolchain node@24.22.3 pnpm@12.21.0 && ' +
        'export PATH=/opt/toolchain/bin:$$PATH && node --version && pnpm --version && ' +
        'pnpm config set store-dir /pnpm/store && pnpm install --frozen-lockfile --ignore-scripts && ' +
        'pnpm --filter @artifactshare/web exec vitest --config vitest.visual.browser.config.ts --run ' +
        (service === compose.services.visual ? '' : '--update ') +
        '$${VITEST_TEST_NAME:+--testNamePattern "$${VITEST_TEST_NAME}"}',
    ])
  }
  assert.match(webPackage.scripts['test:visual-browser'], /docker compose/u)
})

test('all exported package scripts are credential-free and non-publishing', () => {
  assertPublicPackageScriptsAreSafe(
    publicPackagePaths.map((packagePath) => [
      packagePath,
      JSON.parse(fs.readFileSync(packagePath, 'utf8')),
    ]),
  )
})

test('package script reachability rejects deploy, publish, and credentials', () => {
  for (const command of [
    'wrangler deploy',
    'wrangler secret put TOKEN',
    'pnpm --filter app deploy',
    'pnpm publish',
    'npm publish',
    'node task.mjs secrets.DEPLOY_TOKEN',
  ])
    assert.throws(() =>
      assertPublicPackageScriptsAreSafe([
        ['package.json', { scripts: { validate: command } }],
      ]),
    )
})

test('package script reachability allows Wrangler dry-run builds', () => {
  assert.doesNotThrow(() =>
    assertPublicPackageScriptsAreSafe([
      [
        'package.json',
        {
          scripts: {
            build: 'wrangler deploy -c wrangler.jsonc --dry-run --outdir build',
          },
        },
      ],
    ]),
  )
})

test('production command exceptions reject extra publishing or credential commands', () => {
  const scripts = JSON.parse(
    fs.readFileSync('apps/web/package.json', 'utf8'),
  ).scripts
  for (const name of ['deploy:production', 'deploy:production:built']) {
    for (const extra of [
      ' && npm publish',
      ' && wrangler secret put TOKEN',
      ' && pnpm exec wrangler deploy',
    ]) {
      assert.throws(() =>
        assertPublicPackageScriptsAreSafe([
          [
            'apps/web/package.json',
            { scripts: { [name]: scripts[name] + extra } },
          ],
        ]),
      )
    }
  }
})

test('standalone CLI validation builds contracts and CI/release smoke-test the packed artifact', () => {
  const cli = JSON.parse(fs.readFileSync('packages/cli/package.json', 'utf8'))
  const root = JSON.parse(fs.readFileSync('package.json', 'utf8'))
  for (const command of ['build', 'typecheck']) {
    assert.ok(
      cli.scripts[command].startsWith(
        'pnpm --filter @artifactshare/contract build && ',
      ),
    )
  }
  assert.ok(cli.scripts.test.startsWith('pnpm run build && '))
  assert.equal(cli.dependencies['@artifactshare/contract'], undefined)
  assert.equal(cli.devDependencies['@artifactshare/contract'], 'workspace:*')
  assert.match(
    root.scripts['validate:cli'],
    /pnpm --filter @artifactshare\/cli test:package/,
  )
  assert.match(
    fs.readFileSync('.github/workflows/release-cli.yml', 'utf8'),
    /pnpm --filter @artifactshare\/cli test:package/,
  )
})

test('CLI release is tag or manual, current-main-only, preflighted, and OIDC-only', () => {
  const releaseWorkflow = YAML.parse(
    fs.readFileSync('.github/workflows/release-cli.yml', 'utf8'),
  )
  assert.deepEqual(releaseWorkflow.on.push.tags, ['cli-v*'])
  assert.deepEqual(Object.keys(releaseWorkflow.on).sort(), [
    'push',
    'workflow_dispatch',
  ])
  const { version } = releaseWorkflow.on.workflow_dispatch.inputs
  assert.equal(version.required, true)
  assert.equal(version.type, 'string')
  assert.deepEqual(releaseWorkflow.permissions, {})

  const pack = releaseWorkflow.jobs.pack
  const packText = JSON.stringify(pack)
  const packRuns = pack.steps.map((step) => step.run ?? '').join('\n')
  assert.equal(pack.permissions.contents, 'read')
  assert.equal(pack.permissions['id-token'], undefined)
  assert.equal(pack.environment, undefined)
  assert.match(
    packRuns,
    /test "\$GITHUB_SHA" = "\$\(git rev-parse origin\/main\)"/,
  )
  assert.match(packRuns, /pnpm check:cli-release/)
  assert.match(packRuns, /TAG_VERSION="\$\{GITHUB_REF_NAME#cli-v\}"/)
  assert.match(packRuns, /test "\$TAG_VERSION" = "\$PKG_VERSION"/)
  assert.match(packRuns, /test "\$GITHUB_REF_NAME" = "main"/)
  assert.match(packRuns, /TAG_VERSION="\$RELEASE_VERSION"/)
  assert.match(packRuns, /git ls-remote --exit-code --tags origin/)
  assert.match(packRuns, /npm view.*PKG_NAME.*PKG_VERSION.*version/)
  assert.match(packRuns, /pnpm check:cli-reference/)
  assert.match(packRuns, /@artifactshare\/cli pack --pack-destination/)
  assert.match(packRuns, /startsWith\("workspace:"\)/)
  assert.match(packRuns, /sha256sum "\$\(basename "\$TGZ"\)" > SHA256SUMS/)
  assert.match(packText, /actions\/upload-artifact@[0-9a-f]{40}/)
  assert.doesNotMatch(packRuns, /^\s*(?:npm|pnpm)(?:\s+\S+)*\s+publish\b/mu)
  assert.doesNotMatch(packText, /secrets\./)

  const publish = releaseWorkflow.jobs.publish
  const publishRuns = publish.steps.map((step) => step.run ?? '').join('\n')
  assert.equal(publish.needs, 'pack')
  assert.equal(publish.environment, 'production')
  assert.equal(publish.permissions['id-token'], 'write')
  assert.match(publishRuns, /sha256sum --check SHA256SUMS/)
  assert.match(publishRuns, /test "\$\{#tarballs\[@\]\}" -eq 1/)
  assert.match(
    publishRuns,
    /pnpm publish "\$\{tarballs\[0\]\}" --no-git-checks --access public --provenance/,
  )
  assert.doesNotMatch(JSON.stringify(publish), /secrets\./)
  assert.doesNotMatch(publishRuns, /pnpm install/)

  assert.equal(releaseWorkflow.jobs.tag, undefined)
})

test('reserved package release is protected, tag-only, and OIDC-only', () => {
  const releaseWorkflow = YAML.parse(
    fs.readFileSync('.github/workflows/release-npm-reserved.yml', 'utf8'),
  )
  assert.deepEqual(releaseWorkflow.on.push.tags, ['reserved-v*'])
  assert.equal(releaseWorkflow.permissions.contents, 'read')
  assert.equal(releaseWorkflow.permissions['id-token'], 'write')
  const release = releaseWorkflow.jobs.release
  assert.equal(release.environment, 'production')
  const text = JSON.stringify(release)
  const runs = release.steps.map((step) => step.run ?? '').join('\n')
  assert.match(runs, /test "\$GITHUB_SHA" = "\$\(git rev-parse origin\/main\)"/)
  assert.match(runs, /pnpm check:npm-reserved/)
  assert.match(runs, /npm view.*PKG_NAME.*PKG_VERSION.*version/)
  assert.match(runs, /npm pack \.\/packages\/npm-reserved/)
  assert.match(runs, /test "\$bin_status" -eq 1/)
  assert.match(text, /npm publish --access public --provenance --tag latest/)
  assert.doesNotMatch(text, /secrets\./)
})

test('qm bridge release is manual, protected, and publishes one verified tarball', () => {
  const releaseWorkflow = YAML.parse(
    fs.readFileSync('.github/workflows/release-qm-bridge.yml', 'utf8'),
  )
  const { version } = releaseWorkflow.on.workflow_dispatch.inputs
  assert.equal(version.required, true)
  assert.equal(version.type, 'string')

  const pack = releaseWorkflow.jobs.pack
  const packText = JSON.stringify(pack)
  const packRuns = pack.steps.map((step) => step.run ?? '').join('\n')
  assert.match(packRuns, /test "\$GITHUB_REF_NAME" = "main"/)
  assert.match(
    packRuns,
    /test "\$GITHUB_SHA" = "\$\(git rev-parse origin\/main\)"/,
  )
  assert.match(packRuns, /test "\$RELEASE_VERSION" = "\$PKG_VERSION"/)
  assert.match(packRuns, /npm view.*PKG_NAME.*PKG_VERSION.*version/)
  assert.match(packRuns, /@artifactshare\/qm-bridge typecheck/)
  assert.match(packRuns, /@artifactshare\/qm-bridge test/)
  assert.match(packRuns, /@artifactshare\/qm-bridge pack/)
  assert.match(packRuns, /invalid_cli_usage/)
  assert.match(packText, /actions\/upload-artifact@[0-9a-f]{40}/)
  assert.doesNotMatch(packText, /secrets\./)

  const publish = releaseWorkflow.jobs.publish
  assert.equal(publish.needs, 'pack')
  assert.equal(publish.environment, 'production')
  const publishRuns = publish.steps.map((step) => step.run ?? '').join('\n')
  assert.match(publishRuns, /sha256sum --check SHA256SUMS/)
  assert.match(publishRuns, /test "\$\{#tarballs\[@\]\}" -eq 1/)
  assert.match(
    publishRuns,
    /npm publish "\$\{tarballs\[0\]\}" --access public --provenance/,
  )
})

test('every container in public CI is the locked Playwright image', () => {
  const compose = YAML.parse(visualCompose, { merge: true })
  const image = compose.services.visual.image
  const version = image.match(/:v([\d.]+)-noble@sha256:[a-f0-9]{64}$/)?.[1]
  assert.ok(version)
  const documents = YAML.parseAllDocuments(
    fs.readFileSync('pnpm-lock.yaml', 'utf8'),
  )
  for (const document of documents) assert.deepEqual(document.errors, [])
  const locks = documents.map((document) => document.toJS())
  const workspaceLocks = locks.filter((lock) => lock.importers?.['apps/web'])
  assert.equal(workspaceLocks.length, 1)
  const [lock] = workspaceLocks
  const dependency = lock.importers['apps/web'].devDependencies.playwright
  assert.equal(dependency.specifier, version)
  assert.equal(dependency.version, version)
  assert.ok(lock.packages[`playwright@${version}`])
  assert.ok(lock.packages[`playwright-core@${version}`])
  assert.equal(
    JSON.parse(fs.readFileSync('package.json', 'utf8')).packageManager,
    'pnpm@12.21.0',
  )
  const containers = Object.entries(parsedWorkflow.jobs).filter(
    ([, job]) => job.container !== undefined,
  )
  assert.ok(containers.length > 0)
  for (const [name, job] of containers)
    assert.equal(job.container.image, image, name)
})

test('image-backed CI installs no browsers or system packages at run time', () => {
  const nightly = [
    '.github/workflows/flaky-detector.yml',
    '.github/workflows/nightly-journeys.yml',
  ].map((file) => fs.readFileSync(file, 'utf8'))
  for (const source of [workflow, ...nightly])
    assert.doesNotMatch(
      source,
      /playwright install|install-deps|\bapt(?:-get)?\b|browser-cache-|browser-system-packages|actions\/cache(?:\/restore|\/save)?@/,
    )
})
