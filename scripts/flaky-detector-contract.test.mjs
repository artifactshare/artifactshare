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

test('a repetition timeout leaves room inside the worker job budget', async () => {
  const { repetitionTimeoutMs } = await import('./ci/flaky-runs.mjs')
  const jobBudgetMs = workflow.jobs.worker['timeout-minutes'] * 60_000
  assert.equal(typeof workflow.jobs.worker['timeout-minutes'], 'number')
  assert.ok(repetitionTimeoutMs > 0)
  // A repetition that times out must leave the job time to finish the rest of
  // the repetitions and upload its results, so the runner never kills the job
  // mid-run and loses them. Three full repetition budgets is that room; either
  // value moving without the other trips this.
  assert.ok(
    repetitionTimeoutMs * 3 <= jobBudgetMs,
    `repetition timeout ${repetitionTimeoutMs}ms does not fit three times into the worker job budget ${jobBudgetMs}ms`,
  )
})

test('the detector never cancels a run in progress', () => {
  assert.deepEqual(workflow.concurrency, {
    group: 'flaky-detector',
    'cancel-in-progress': false,
  })
})
