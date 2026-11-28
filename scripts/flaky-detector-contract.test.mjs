import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import YAML from 'yaml'

const workflow = YAML.parse(
  fs.readFileSync('.github/workflows/flaky-detector.yml', 'utf8'),
)

const stepIndex = (job, script) =>
  job.steps.findIndex((step) => (step.run ?? '').includes(script))
const stepThatRuns = (job, script) => job.steps[stepIndex(job, script)]

test('the nightly report runs after failed workers and tolerates missing shards', () => {
  const report = workflow.jobs.report
  assert.deepEqual(report.needs, ['plan', 'worker'])
  assert.equal(report.if, "always() && needs.plan.result == 'success'")
  const download = report.steps.find((step) =>
    step.uses?.startsWith('actions/download-artifact@'),
  )
  assert.equal(download['continue-on-error'], true)
  assert.equal(download.with.pattern, 'flaky-results-*')
  assert.equal(download.with['merge-multiple'], true)
  assert.match(
    stepThatRuns(report, 'flaky-report.mjs').run,
    /flaky-report\.mjs.*REPETITIONS.*GITHUB_SHA/u,
  )
  assert.equal(
    report.steps.find((step) =>
      step.uses?.startsWith('actions/upload-artifact@'),
    ).if,
    'always()',
  )
  assert.equal(
    workflow.jobs.worker.steps.at(-1).if,
    'always()',
    'workers upload their results even when the suite fails',
  )
})

test('the detector writes nothing to the repository', () => {
  // Issues are disabled on this repository, so the report is the run's output:
  // the job log, the step summary and the flaky-report artifact.
  assert.deepEqual(workflow.permissions, { contents: 'read' })
  for (const [name, job] of Object.entries(workflow.jobs))
    assert.equal(job.permissions, undefined, name)
})

test('the detector runs nightly and by hand, and on no other event', () => {
  assert.deepEqual(Object.keys(workflow.on).sort(), [
    'schedule',
    'workflow_dispatch',
  ])
  // A pull request trigger would repeat every suite on every push.
  assert.deepEqual(workflow.on.schedule, [{ cron: '17 2 * * *' }])
})

// Checkout, pnpm install, the fixture and contract builds and the results
// upload all run inside the worker job's timeout-minutes, around the
// repetitions. The repetitions must leave that much of the budget unspent, or
// the runner kills the job before the upload and the run's results are lost.
//
// The reserve below is a chosen one, read off the real jobs rather than
// guessed: across the 120 worker jobs of runs 45986151845 and 45603813370,
// everything outside the "Repeat the whole suite" step took at most 1.13
// minutes, 0.73 at the median, with the slowest single step the browser
// container setup. Five minutes is roughly four times that worst case, which
// absorbs a slow runner or a cold pnpm store without being so wide that it
// forbids a repetition timeout the budget can actually afford.
const WORKER_SETUP_AND_UPLOAD_MS = 5 * 60_000

test('a repetition timeout leaves room inside the worker job budget', async () => {
  const { repetitionTimeoutMs, plan, validateCount } =
    await import('./ci/flaky-runs.mjs')
  const jobBudgetMs = workflow.jobs.worker['timeout-minutes'] * 60_000
  assert.equal(typeof workflow.jobs.worker['timeout-minutes'], 'number')
  assert.ok(repetitionTimeoutMs > 0)
  // One worker job runs the repetitions of one shard, so the worst case is
  // every one of them cut by the timeout. Read that count from plan() at the
  // largest request it accepts instead of restating it, so resharding is
  // checked here rather than silently eating the margin.
  const runsPerShard = Math.max(
    ...plan(validateCount(50)).map((shard) => shard.runs.length),
  )
  assert.ok(runsPerShard > 0)
  const spentMs = repetitionTimeoutMs * runsPerShard
  assert.ok(
    spentMs + WORKER_SETUP_AND_UPLOAD_MS <= jobBudgetMs,
    `${runsPerShard} repetitions of ${repetitionTimeoutMs}ms leave ${jobBudgetMs - spentMs}ms of the ${jobBudgetMs}ms worker job budget, under the ${WORKER_SETUP_AND_UPLOAD_MS}ms its setup and upload steps need`,
  )
})

test('the detector never cancels a run in progress', () => {
  assert.deepEqual(workflow.concurrency, {
    group: 'flaky-detector',
    'cancel-in-progress': false,
  })
})
