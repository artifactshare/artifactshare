import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import YAML from 'yaml'

const workflow = YAML.parse(
  fs.readFileSync('.github/workflows/flaky-detector.yml', 'utf8'),
)
const ci = YAML.parse(
  fs.readFileSync('.github/workflows/public-ci.yml', 'utf8'),
)
const release = YAML.parse(
  fs.readFileSync('.github/workflows/release-qm-bridge.yml', 'utf8'),
)
const steps = workflow.jobs.worker.steps

test('independent daily/dispatch workflow validates before installing or scheduling workers', () => {
  assert.deepEqual(Object.keys(workflow.on).sort(), [
    'schedule',
    'workflow_dispatch',
  ])
  assert.equal(workflow.on.workflow_dispatch.inputs.repetitions.default, '20')
  assert.deepEqual(workflow.on.schedule, [{ cron: '17 2 * * *' }])
  assert.deepEqual(workflow.permissions, { contents: 'read' })
  assert.equal(workflow.jobs.worker.needs, 'plan')
  assert.equal(
    workflow.jobs.plan.steps.at(-1).run,
    'node scripts/ci/flaky-runs.mjs plan',
  )
  assert.match(
    workflow.jobs.plan.steps.at(-1).env.REPETITIONS,
    /schedule.*20.*inputs.repetitions/,
  )
  assert.ok(
    !workflow.jobs.plan.steps.some((step) => step.run?.includes('install')),
  )
  assert.equal(workflow.jobs.worker.strategy['fail-fast'], false)
  assert.equal(workflow.jobs.worker.strategy['max-parallel'], undefined)
  assert.equal(
    workflow.jobs.worker.strategy.matrix,
    '${{ fromJSON(needs.plan.outputs.matrix) }}',
  )
})

test('setup pins, immutable SHA, permissions, explicit timeouts match CI', () => {
  const pins = new Set(
    [...Object.values(ci.jobs), ...Object.values(release.jobs)]
      .flatMap((job) => job.steps ?? [])
      .map((step) => step.uses)
      .filter(Boolean),
  )
  pins.add('actions/cache/save@55cc8345863c7cc4c66a329aec7e433d2d1c52a9')
  for (const [name, job] of Object.entries(workflow.jobs)) {
    assert.equal(job['runs-on'], 'ubuntu-latest')
    assert.equal(job['timeout-minutes'], name === 'worker' ? 60 : 10)
    for (const step of job.steps) {
      if (!step.uses) continue
      assert.match(step.uses, /@[a-f0-9]{40}$/)
      assert.ok(pins.has(step.uses))
      if (step.uses.startsWith('actions/checkout@')) {
        assert.equal(step.with.ref, '${{ github.sha }}')
        assert.equal(step.with['persist-credentials'], false)
      }
      if (step.uses.startsWith('actions/setup-node@'))
        assert.equal(step.with['node-version'], '24.21.0')
    }
  }
  assert.ok(
    steps.some(
      (step) =>
        step.uses?.startsWith('pnpm/action-setup@') && !step.with?.version,
    ),
  )
  assert.ok(
    steps.some(
      (step) => step.run === 'pnpm install --frozen-lockfile --ignore-scripts',
    ),
  )
})

test('browser installation precedes suite execution', () => {
  const index = (command) => steps.findIndex((step) => step.run === command)
  const install = index(
    'pnpm --filter @artifactshare/web exec playwright install --with-deps chromium firefox webkit',
  )
  const run = index('node scripts/ci/flaky-runs.mjs run')
  assert.ok(install >= 0 && run > install)
  assert.equal(steps[install]['continue-on-error'], undefined)
  assert.equal(steps[run]['continue-on-error'], undefined)
  assert.equal(steps[install].if, "matrix.suite == 'behavior-browser'")
  assert.ok(index('pnpm --filter @artifactshare/contract build') < run)
  assert.ok(index('pnpm fixtures:build') < run)
  assert.equal(steps[run].env.SHARD, '${{ toJSON(matrix) }}')
  const upload = steps.at(-1)
  assert.equal(upload.if, 'always()')
  assert.equal(
    upload.with.name,
    'flaky-results-${{ matrix.id }}-${{ matrix.shard }}',
  )
})

test('aggregation runs after failed workers, tolerates missing artifacts, and uploads failed verdicts', () => {
  const job = workflow.jobs.report
  assert.deepEqual(job.needs, ['plan', 'worker'])
  assert.equal(job.if, "always() && needs.plan.result == 'success'")
  const download = job.steps.find((step) =>
    step.uses?.startsWith('actions/download-artifact@'),
  )
  assert.equal(download['continue-on-error'], true)
  assert.equal(download.with.pattern, 'flaky-results-*')
  assert.equal(download.with['merge-multiple'], true)
  assert.match(
    job.steps.at(-2).run,
    /flaky-report.mjs.*REPETITIONS.*GITHUB_SHA/,
  )
  assert.equal(job.steps.at(-1).if, 'always()')
  assert.equal(job.steps.at(-1).with.name, 'flaky-report')
  const doc = fs.readFileSync('docs/development-workflow.md', 'utf8')
  assert.match(doc, /\.github\/workflows\/flaky-detector.yml/)
  for (const phrase of [
    '02:17 UTC',
    'Run workflow',
    'consistently failing',
    'Missing artifacts',
    'separate test fixes',
  ])
    assert.ok(doc.includes(phrase))
})

test('overlapping detector runs are independent rather than replacing pending runs', () => {
  assert.equal(workflow.concurrency, undefined)
  assert.match(
    fs.readFileSync('docs/development-workflow.md', 'utf8'),
    /Overlapping workflow runs execute independently/,
  )
})

test('every flaky detector job uses stock Playwright libraries', () => {
  assert.doesNotMatch(
    JSON.stringify(workflow),
    /replace-webkit-libsoup|webkit-libsoup|WEBKIT_LIBSOUP_CACHE_DIR/i,
  )
})

test('only default-branch browser workers best-effort stage and save archives before repetition', () => {
  const guard =
    "matrix.suite == 'behavior-browser' && (github.event_name == 'schedule' || (github.event_name == 'workflow_dispatch' && github.event.repository.default_branch != '' && github.ref == format('refs/heads/{0}', github.event.repository.default_branch)))"
  const imageGuard =
    "steps.browser-cache-image.outcome == 'success' && env.ImageOS != ''"
  const ids = [
    'browser-cache-image',
    'browser-cache-stage',
    'browser-cache-save',
  ]
  const [image, stage, save] = ids.map((id) => {
    const matches = steps.filter((step) => step.id === id)
    assert.equal(matches.length, 1)
    return matches[0]
  })
  assert.equal(workflow.jobs.worker['continue-on-error'], undefined)
  for (const step of steps) {
    assert.equal(
      step['continue-on-error'],
      ids.includes(step.id) ? true : undefined,
    )
  }
  assert.equal(image.if, '${{ ' + guard + ' }}')
  for (const step of [stage, save])
    assert.equal(step.if, '${{ ' + guard + ' && ' + imageGuard + ' }}')
  const install = steps.findIndex((step) =>
    step.run?.includes('playwright install'),
  )
  assert.deepEqual(steps.slice(install + 1, install + 4), [image, stage, save])
  assert.equal(steps[install + 4].run, 'node scripts/ci/flaky-runs.mjs run')
  assert.equal(steps[install + 4].if, undefined)
  assert.equal(
    stage.run,
    'bash scripts/ci/browser-system-packages.sh /var/cache/apt/archives "$RUNNER_TEMP/browser-system-packages"',
  )
  assert.equal(
    save.uses,
    'actions/cache/save@55cc8345863c7cc4c66a329aec7e433d2d1c52a9',
  )
  assert.match(
    fs.readFileSync('.github/workflows/flaky-detector.yml', 'utf8'),
    /actions\/cache\/save@55cc8345863c7cc4c66a329aec7e433d2d1c52a9 # v6\.1\.0/,
  )
  for (const name of ['browser-validation', 'changed-browser-repetitions']) {
    const restore = ci.jobs[name].steps.find(
      (step) => step.id === 'browser-cache-restore',
    )
    assert.deepEqual(save.with, {
      path: restore.with.path,
      key: restore.with.key,
    })
  }
  assert.ok(
    !steps.some((step) => step.uses?.startsWith('actions/cache/restore@')),
  )

  // Exact YAML guard equality above binds this predicate to the documented event cases.
  const eligible = (suite, event, ref, repository) =>
    suite === 'behavior-browser' &&
    (event === 'schedule' ||
      (event === 'workflow_dispatch' &&
        Boolean(repository?.default_branch) &&
        ref === `refs/heads/${repository.default_branch}`))
  for (const [event, ref, repository, expected] of [
    ['schedule', 'refs/heads/main', undefined, true],
    ['workflow_dispatch', 'refs/heads/main', { default_branch: 'main' }, true],
    [
      'workflow_dispatch',
      'refs/heads/other',
      { default_branch: 'main' },
      false,
    ],
    ['workflow_dispatch', 'refs/tags/main', { default_branch: 'main' }, false],
    ['workflow_dispatch', 'refs/heads/main', undefined, false],
    ['workflow_dispatch', 'refs/heads/main', {}, false],
    ['workflow_dispatch', 'refs/heads/', { default_branch: '' }, false],
  ]) {
    assert.equal(eligible('behavior-browser', event, ref, repository), expected)
    assert.equal(eligible('scripts', event, ref, repository), false)
  }
})
