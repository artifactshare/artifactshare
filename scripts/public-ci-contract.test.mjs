import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import YAML from 'yaml'

const workflowPath = '.github/workflows/public-ci.yml'
const workflow = fs.readFileSync(workflowPath, 'utf8')
const parsedWorkflow = YAML.parse(workflow)
const visualConfig = fs.readFileSync(
  'apps/web/vitest.visual.browser.config.ts',
  'utf8',
)
const visualCompose = fs.readFileSync('compose.playwright.yml', 'utf8')

const publicPackagePaths = [
  'package.json',
  'apps/web/package.json',
  'packages/cli/package.json',
  'tools/static-site-fixtures/package.json',
]

export function assertPublicPackageScriptsAreSafe(packages) {
  for (const [packagePath, packageJson] of packages)
    for (const [name, command] of Object.entries(packageJson.scripts ?? {})) {
      const label = `${packagePath}#${name}`
      if (label === 'apps/web/package.json#deploy:production') {
        assert.match(
          command,
          /^pnpm build:production && pnpm build:alerts:production && pnpm build:og-image:production && pnpm build:sandbox:production && pnpm db:apply:remote:production && .+wrangler deploy -c wrangler\.alerts\.jsonc --env production && .+wrangler deploy -c wrangler\.og-image\.jsonc --env production && .+wrangler deploy -c wrangler\.sandbox\.jsonc --env production && .+wrangler deploy$/u,
          label,
        )
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

test('public CI is valid YAML', () => {
  assert.deepEqual(YAML.parseDocument(workflow).errors, [])
})

test('YAML parser rejects malformed workflow syntax', () => {
  assert.notEqual(YAML.parseDocument('jobs:\n\tvalidate: bad').errors.length, 0)
})

test('public CI is hosted and credential-free', () => {
  assert.match(workflow, /runs-on:\s*ubuntu-latest/)
  assert.doesNotMatch(
    workflow,
    /pull_request_target|self-hosted|secrets\.|wrangler\s+(deploy|secret)|pnpm\s+(deploy|publish)|npm\s+publish/i,
  )
})

test('public CI pins external actions and disables install scripts', () => {
  const actionRefs = [...workflow.matchAll(/^\s*- uses:\s*([^\s#]+)/gmu)].map(
    (match) => match[1],
  )
  assert.ok(actionRefs.length > 0)
  for (const actionRef of actionRefs) {
    if (actionRef.startsWith('./')) continue
    assert.match(actionRef, /^[^@\s]+@[0-9a-f]{40}$/u, actionRef)
  }
  assert.match(workflow, /pnpm install --frozen-lockfile --ignore-scripts/)
  assert.doesNotMatch(workflow, /persist-credentials:\s*true/)
})

test('PRs run only the install-free boundary guard', () => {
  const guard = JSON.stringify(parsedWorkflow.jobs['pull-request-guard'])
  assert.match(workflow, /pull-request-guard:/)
  assert.match(workflow, /if: github\.event_name == 'pull_request'/)
  assert.doesNotMatch(guard, /pnpm install|pnpm validate|test:runtime/)
  assert.match(workflow, /--base\s+"\$PUBLIC_PR_BASE"/)
  assert.match(workflow, /--head\s+"\$PUBLIC_PR_HEAD"/)
  assert.match(workflow, /--head-repo-full-name\s+"\$PUBLIC_PR_HEAD_REPO"/)
  assert.match(workflow, /--base-repo-full-name\s+"\$PUBLIC_PR_BASE_REPO"/)
  assert.match(
    workflow,
    /git -C "\$GITHUB_WORKSPACE\/head" fetch --no-tags "\$GITHUB_WORKSPACE\/trusted" "\$PUBLIC_PR_BASE"/,
  )
})

test('PR guard has an exact trusted five-step topology', () => {
  const guard = parsedWorkflow.jobs['pull-request-guard']
  assert.equal(guard.name, undefined)
  assert.equal(guard.if, "github.event_name == 'pull_request'")
  assert.equal(guard['runs-on'], 'ubuntu-latest')
  assert.equal(guard.permissions, undefined)
  assert.equal(guard.defaults, undefined)
  assert.equal(parsedWorkflow.defaults, undefined)
  assert.deepEqual(parsedWorkflow.permissions, { contents: 'read' })
  assert.equal(guard.steps.length, 5)

  const [classify, trusted, head, boundary, summary] = guard.steps
  assert.equal(classify.id, 'classify')
  assert.equal(trusted.with.path, 'trusted')
  assert.equal(head.with.path, 'head')
  assert.equal(boundary.id, 'boundary')
  assert.equal(summary.id, 'summary')
  assert.ok(trusted.uses.startsWith('actions/checkout@'))
  assert.ok(head.uses.startsWith('actions/checkout@'))
  assert.equal(trusted.with.ref, '${{ github.event.pull_request.base.sha }}')
  assert.equal(head.with.ref, '${{ github.event.pull_request.head.sha }}')
  for (const checkout of [trusted, head]) {
    assert.equal(checkout.with['persist-credentials'], false)
    assert.equal(checkout.with['fetch-depth'], 0)
    assert.equal(checkout.with['fetch-tags'], false)
  }
  assert.equal(classify.shell, undefined)
  assert.equal(classify.if, undefined)
  assert.equal(boundary.shell, undefined)
  assert.equal(boundary.if, undefined)
  assert.equal(summary.shell, undefined)
  assert.doesNotMatch(JSON.stringify(guard), /continue-on-error/u)
})

test('PR classification matches the trusted guard predicate', () => {
  const guard = parsedWorkflow.jobs['pull-request-guard']
  const classify = guard.steps[0]
  const boundary = guard.steps[3]
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
  assert.equal(
    boundary.name,
    "${{ steps.classify.outputs.is_maintainer == 'true' && 'Check maintainer pull request boundary' || 'Check proposal-only boundary' }}",
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

test('PR boundary retains every trusted input and argument', () => {
  const boundary = parsedWorkflow.jobs['pull-request-guard'].steps[3]
  assert.equal(boundary.run.split('\n')[0], 'set -euo pipefail')
  assert.deepEqual(boundary.env, {
    PUBLIC_PR_TITLE: '${{ github.event.pull_request.title }}',
    PUBLIC_PR_BODY: '${{ github.event.pull_request.body }}',
    PUBLIC_PR_BASE: '${{ github.event.pull_request.base.sha }}',
    PUBLIC_PR_HEAD: '${{ github.event.pull_request.head.sha }}',
    PUBLIC_PR_HEAD_REPO: '${{ github.event.pull_request.head.repo.full_name }}',
    PUBLIC_PR_BASE_REPO: '${{ github.event.pull_request.base.repo.full_name }}',
  })
  for (const literal of [
    "fs.writeFileSync(process.env.RUNNER_TEMP + '/public-pr-title.txt', process.env.PUBLIC_PR_TITLE ?? '')",
    "fs.writeFileSync(process.env.RUNNER_TEMP + '/public-pr-body.txt', process.env.PUBLIC_PR_BODY ?? '')",
    'git -C "$GITHUB_WORKSPACE/head" fetch --no-tags "$GITHUB_WORKSPACE/trusted" "$PUBLIC_PR_BASE"',
    'node trusted/scripts/public-development-guard.mjs --ci-pr',
    '--repo "$GITHUB_WORKSPACE/head"',
    '--manifest-repo "$GITHUB_WORKSPACE/trusted"',
    '--base "$PUBLIC_PR_BASE"',
    '--head "$PUBLIC_PR_HEAD"',
    '--head-repo-full-name "$PUBLIC_PR_HEAD_REPO"',
    '--base-repo-full-name "$PUBLIC_PR_BASE_REPO"',
    '--metadata-file "$RUNNER_TEMP/public-pr-title.txt"',
    '--metadata-file "$RUNNER_TEMP/public-pr-body.txt"',
  ])
    assert.ok(boundary.run.includes(literal), literal)
  assert.equal((boundary.run.match(/node -e /gu) ?? []).length, 1)
  assert.doesNotMatch(boundary.run, /\$\{\{/u)
})

test('PR summaries are static, exact, and fail closed', () => {
  const summary = parsedWorkflow.jobs['pull-request-guard'].steps[4]
  assert.equal(summary.if, '${{ !cancelled() }}')
  assert.deepEqual(summary.env, {
    IS_MAINTAINER: '${{ steps.classify.outputs.is_maintainer }}',
    BOUNDARY_OUTCOME: '${{ steps.boundary.outcome }}',
  })
  assert.equal((JSON.stringify(summary).match(/\$\{\{/gu) ?? []).length, 3)
  assert.ok(summary.run.startsWith('set -euo pipefail\n'))
  assert.match(summary.run, /"\$IS_MAINTAINER"/u)
  assert.match(summary.run, /"\$BOUNDARY_OUTCOME"/u)
  assert.equal(
    (summary.run.match(/\} >> "\$GITHUB_STEP_SUMMARY"/gu) ?? []).length,
    6,
  )
  assert.doesNotMatch(summary.run, /\$\{\{|\$\(|`|\|/u)
  const syntax = spawnSync('bash', ['-n'], {
    encoding: 'utf8',
    input: summary.run,
  })
  assert.equal(syntax.status, 0, syntax.stderr)

  const bodies = {
    maintainerSuccess:
      '## Maintainer pull request boundary\n\nThe public repository boundary passed.\n\nThe pull request is ready for maintainer review.\n',
    maintainerFailure:
      '## Maintainer pull request boundary\n\nThe public repository boundary did not pass.\n\nReview the diagnostic in the failed boundary step.\n',
    maintainerIncomplete:
      '## Maintainer pull request boundary\n\nThe public repository boundary check did not complete.\n\nReview the workflow run before continuing.\n',
    forkSuccess:
      '## Proposal check\n\nThe proposal-only boundary passed.\n\nNo action is required from the contributor. The proposal is ready for maintainer review.\n\nFull repository validation runs later in the merge queue.\n',
    forkFailure:
      '## Proposal check\n\nThe proposal check did not pass.\n\nReview the failed boundary step for details.\n\nCommon requirements to check: an external pull request must add exactly one new .md or .txt file directly in proposals/ (not in a subdirectory) and make no other changes.\n\nThe proposal content, pull request title and body, and commit messages must follow the public-content rules in proposals/README.md.\n\nIf the diagnostic identifies a proposal requirement, push a correction to this pull request. Otherwise, no contributor action is required unless a maintainer requests one.\n',
    forkIncomplete:
      '## Proposal check\n\nThe proposal check did not complete.\n\nNo contributor action is required unless a maintainer requests a change.\n',
  }
  const cases = [
    ['true', 'success', bodies.maintainerSuccess],
    ['true', 'failure', bodies.maintainerFailure],
    ['true', 'skipped', bodies.maintainerIncomplete],
    ['false', 'success', bodies.forkSuccess],
    ['false', 'failure', bodies.forkFailure],
    ['false', 'skipped', bodies.forkIncomplete],
    ['unexpected', 'success', bodies.forkSuccess],
    ['false', 'unexpected', bodies.forkIncomplete],
  ]
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'public-ci-summary-'))
  try {
    for (const [isMaintainer, outcome, expected] of cases) {
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
      assert.equal(fs.readFileSync(output, 'utf8'), expected)
    }
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

test('proposal status copy is exact and correctly placed', () => {
  const contributing = fs.readFileSync('CONTRIBUTING.md', 'utf8')
  const proposals = fs.readFileSync('proposals/README.md', 'utf8')
  const paragraph =
    'GitHub may wait for a maintainer to approve Actions on a pull request from a fork. No action is required from you while approval is pending. After approval, the pull-request-guard check verifies the proposal-only boundary; full repository validation runs later in the merge queue.'
  assert.match(
    contributing,
    /1\. Add one human-written `\.md` or `\.txt` file directly in `proposals\/` \(not in a subdirectory\)\./u,
  )
  assert.match(
    proposals,
    /Add one `\.md` or `\.txt` file directly in `proposals\/` \(not in a subdirectory\) and answer these questions in your own words:/u,
  )
  assert.ok(
    contributing.indexOf('3. Open a pull request') <
      contributing.indexOf(paragraph),
  )
  assert.ok(
    contributing.indexOf(paragraph) <
      contributing.indexOf('You do not need generative AI'),
  )
  assert.ok(
    proposals.indexOf('A proposal-only pull request') <
      proposals.indexOf(paragraph),
  )
  assert.ok(
    proposals.indexOf(paragraph) <
      proposals.indexOf('You do not need generative AI'),
  )
  assert.equal(contributing.split(paragraph).length - 1, 1)
  assert.equal(proposals.split(paragraph).length - 1, 1)
})

test('public full CI is merge-queue-only with a stable check-run name', () => {
  const aggregate = parsedWorkflow.jobs.validate
  assert.equal(aggregate.name, 'Public full validation')
  assert.deepEqual(aggregate.needs, [
    'static-validation',
    'build-validation',
    'cli-validation',
    'windows-cli-validation',
    'browser-validation',
    'visual-validation',
  ])
  assert.match(workflow, /merge_group:\s*\n\s+types: \[checks_requested\]/)
  assert.match(aggregate.if, /always\(\)/u)
  assert.match(aggregate.if, /github\.event_name == 'merge_group'/u)
  const aggregateRun = aggregate.steps.map((step) => step.run ?? '').join('\n')
  assert.equal(
    aggregateRun,
    'test "$STATIC_RESULT" = success && test "$BUILD_RESULT" = success && test "$CLI_RESULT" = success && test "$WINDOWS_CLI_RESULT" = success && test "$BROWSER_RESULT" = success && test "$VISUAL_RESULT" = success',
  )
  assert.doesNotMatch(workflow, /^\s+push:/m)
  assert.doesNotMatch(workflow, /merge_group_head_sha|merge_method/)
})

test('Windows credential validation runs in the merge queue and by manual dispatch', () => {
  const job = parsedWorkflow.jobs['windows-cli-validation']
  assert.equal(job['runs-on'], 'windows-latest')
  assert.match(job.if, /github\.event_name == 'merge_group'/u)
  assert.match(job.if, /github\.event_name == 'workflow_dispatch'/u)
  assert.match(workflow, /workflow_dispatch:/u)
  const checkout = job.steps.find((step) =>
    step.uses?.startsWith('actions/checkout@'),
  )
  assert.equal(checkout.with.ref, '${{ github.sha }}')
  const runs = job.steps.map((step) => step.run ?? '').join('\n')
  assert.match(runs, /vitest run src\/token-store\.test\.ts/u)
  assert.doesNotMatch(runs, /icacls/u)
})

test('every executable validation lane checks out the merge-group SHA', () => {
  for (const jobName of [
    'static-validation',
    'build-validation',
    'cli-validation',
    'browser-validation',
    'visual-validation',
  ]) {
    const job = parsedWorkflow.jobs[jobName]
    assert.equal(job.if, "github.event_name == 'merge_group'", jobName)
    const checkout = job.steps.find((step) =>
      step.uses?.startsWith('actions/checkout@'),
    )
    assert.ok(checkout, jobName)
    assert.equal(checkout.with.ref, '${{ github.sha }}', jobName)
    assert.equal(checkout.with['persist-credentials'], false, jobName)
    assert.equal(checkout.with['fetch-depth'], 0, jobName)
    assert.doesNotMatch(JSON.stringify(job), /continue-on-error/u, jobName)
  }
})

test('browser lane shares one topology after behavior validation', () => {
  const runs = parsedWorkflow.jobs['browser-validation'].steps
    .map((step) => step.run ?? '')
    .join('\n')
  const behaviorIndex = runs.indexOf('pnpm test:behavior-browser')
  const localStateIndex = runs.indexOf('pnpm check:browser-local-state')
  assert.ok(behaviorIndex >= 0)
  assert.ok(behaviorIndex < localStateIndex)
  assert.doesNotMatch(runs, /pnpm check:dev-setup/u)
  assert.doesNotMatch(runs, /pnpm check:scenario-routes/u)
  assert.doesNotMatch(runs, /pnpm check:in-app-navigation/u)
  assert.match(runs, /playwright install --with-deps chromium/u)
  assert.doesNotMatch(
    JSON.stringify(parsedWorkflow.jobs['browser-validation']),
    /PLAYWRIGHT_CHANNEL/u,
  )

  const harness = fs.readFileSync('scripts/browser-local-state.mjs', 'utf8')
  const scenarioIndex = harness.indexOf('scenario-route-integration.mjs')
  const navigationIndex = harness.indexOf('in-app-navigation.mjs')
  assert.ok(scenarioIndex >= 0)
  assert.ok(scenarioIndex < navigationIndex)
  assert.equal((harness.match(/prepareDevEnvironment\(/gu) ?? []).length, 1)
  assert.equal((harness.match(/dev:app/gu) ?? []).length, 1)
  assert.match(
    harness,
    /if \(process\.env\.APP_BASE_URL && process\.env\.APP_BASE_URL !== baseUrl\)/u,
  )
  assert.match(harness, /await assertPortAvailable\(\)/u)
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
  assert.equal(parsedWorkflow.jobs['static-validation']['timeout-minutes'], 30)
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
  assert.doesNotMatch(validationRuns, /pnpm fixtures:build/u)
  assert.doesNotMatch(buildRuns, /pnpm fixtures:build/u)
  assert.match(buildRuns, /pnpm db:apply:local/u)
  assert.match(buildRuns, /pnpm check:dev-setup/u)
  assert.match(buildRuns, /pnpm validate:build/u)
  assert.match(rootPackage.scripts['validate:static'], /pnpm test:unit:noncli/u)
  assert.doesNotMatch(
    rootPackage.scripts['validate:static'],
    /artifactshare\/cli/u,
  )
  assert.match(rootPackage.scripts['validate:static'], /pnpm check:doctor/u)
  assert.match(cliRuns, /pnpm validate:cli/u)
  assert.equal(
    rootPackage.scripts['validate:cli'],
    'pnpm --filter @artifactshare/cli test && pnpm check:cli-reference',
  )
  assert.match(rootPackage.scripts['validate:build'], /pnpm build/u)
  assert.match(rootPackage.scripts['validate:build'], /integration:test:run/u)
  assert.match(rootPackage.scripts['validate:build'], /pnpm test:runtime/u)
  assert.equal(
    rootPackage.scripts['validate:nonvisual'],
    'pnpm validate:static && pnpm validate:cli && pnpm test:behavior-browser && pnpm validate:build',
  )
})

test('Linux visual validation is an independent required lane', () => {
  const visual = parsedWorkflow.jobs['visual-validation']
  assert.equal(visual['runs-on'], 'ubuntu-latest')
  assert.equal(visual['timeout-minutes'], 20)
  assert.match(
    visual.steps.map((step) => step.run ?? '').join('\n'),
    /docker compose -f compose\.playwright\.yml run --rm visual/u,
  )
  assert.doesNotMatch(JSON.stringify(visual), /continue-on-error/u)
})

test('CLI release is tag-only, current-main-only, preflighted, and OIDC-only', () => {
  const releaseWorkflow = YAML.parse(
    fs.readFileSync('.github/workflows/release-cli.yml', 'utf8'),
  )
  assert.deepEqual(releaseWorkflow.on.push.tags, ['cli-v*'])
  assert.equal(releaseWorkflow.permissions.contents, 'read')
  assert.equal(releaseWorkflow.permissions['id-token'], 'write')
  const release = releaseWorkflow.jobs.release
  assert.equal(release['runs-on'], 'ubuntu-latest')
  const text = JSON.stringify(release)
  const runs = release.steps.map((step) => step.run ?? '').join('\n')
  assert.match(runs, /test "\$GITHUB_SHA" = "\$\(git rev-parse origin\/main\)"/)
  assert.match(runs, /pnpm check:cli-release/)
  assert.match(runs, /npm view.*PKG_NAME.*PKG_VERSION.*version/)
  assert.match(runs, /pnpm check:cli-reference/)
  assert.match(
    text,
    /pnpm publish --no-git-checks --access public --provenance/,
  )
  assert.doesNotMatch(text, /secrets\./)
})

test('public CI installs Playwright from the web workspace', () => {
  assert.match(
    workflow,
    /run:\s*pnpm --filter @artifactshare\/web exec playwright install --with-deps chromium/,
  )
  assert.doesNotMatch(
    workflow,
    /run:\s*pnpm exec playwright install --with-deps chromium/,
  )
})

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
