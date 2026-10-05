import { spawnSync } from 'node:child_process'
import { PIN } from './ci/replace-webkit-libsoup.mjs'
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

test('browser installation and one WebKit workaround precede suite execution', () => {
  const index = (command) => steps.findIndex((step) => step.run === command)
  const install = index(
    'pnpm --filter @artifactshare/web exec playwright install --with-deps chromium firefox webkit',
  )
  const workaround = index('node scripts/ci/replace-webkit-libsoup.mjs')
  const run = index('node scripts/ci/flaky-runs.mjs run')
  assert.ok(install >= 0 && workaround > install && run > workaround)
  assert.equal(steps[workaround].if, "matrix.project == 'webkit'")
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

test('libsoup cache is pin-derived, exact, restored before use and independently verified', () => {
  const lane = steps
  const key = lane.find((step) => step.id === 'webkit-libsoup-cache-key')
  const cache = lane.find((step) => step.uses?.startsWith('actions/cache@'))
  const patch = lane.find(
    (step) => step.run === 'node scripts/ci/replace-webkit-libsoup.mjs',
  )
  assert.ok(key && cache && patch)
  assert.equal(
    cache.uses,
    'actions/cache@55cc8345863c7cc4c66a329aec7e433d2d1c52a9',
  )
  assert.equal(key.if, "matrix.project == 'webkit'")
  assert.equal(cache.if, "matrix.project == 'webkit'")
  assert.equal(patch.if, "matrix.project == 'webkit'")
  assert.equal(cache['continue-on-error'], undefined)
  assert.equal(key['continue-on-error'], undefined)
  assert.equal(patch['continue-on-error'], undefined)
  assert.deepEqual(cache.with, {
    path: '${{ runner.temp }}/webkit-libsoup-cache',
    key: '${{ steps.webkit-libsoup-cache-key.outputs.key }}',
  })
  assert.equal(patch.env.WEBKIT_LIBSOUP_CACHE_DIR, cache.with.path)
  const setup = lane.findIndex((step) =>
    step.uses?.startsWith('actions/setup-node@'),
  )
  const install = lane.findIndex((step) =>
    step.run?.includes('playwright install'),
  )
  assert.ok(setup < lane.indexOf(key))
  assert.ok(lane.indexOf(key) < lane.indexOf(cache))
  assert.ok(lane.indexOf(cache) < install)
  assert.ok(install < lane.indexOf(patch))
  assert.doesNotMatch(JSON.stringify(lane), /cache-hit|restore-keys/)
  assert.match(
    key.run,
    /import \{ PIN \} from '\.\/scripts\/ci\/replace-webkit-libsoup\.mjs'/,
  )
  const lines = key.run.trim().split('\n')
  assert.equal(
    lines[0],
    `node --input-type=module <<'NODE' >> "$GITHUB_OUTPUT"`,
  )
  assert.equal(lines.at(-1), 'NODE')
  const result = spawnSync(
    process.execPath,
    ['--input-type=module', '-e', lines.slice(1, -1).join('\n')],
    { encoding: 'utf8' },
  )
  assert.equal(result.status, 0, result.stderr)
  assert.equal(
    result.stdout.trim(),
    `key=webkit-libsoup-linux-ubuntu-24.04-v1-${PIN.sha256}-${PIN.libraries.map((library) => library.replacement).join('-')}`,
  )
})

test('detector and CI share the exact cache key formula and directory', () => {
  const browser = ci.jobs['browser-validation'].steps
  assert.equal(
    steps.find((step) => step.id === 'webkit-libsoup-cache-key').run,
    browser.find((step) => step.id === 'webkit-libsoup-cache-key').run,
  )
  assert.deepEqual(
    steps.find((step) => step.uses?.startsWith('actions/cache@')).with,
    browser.find((step) => step.uses?.startsWith('actions/cache@')).with,
  )
})
