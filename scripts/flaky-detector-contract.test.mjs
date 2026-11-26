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

test('only the report job may write, and only to issues', () => {
  assert.deepEqual(workflow.permissions, { contents: 'read' })
  assert.deepEqual(workflow.jobs.report.permissions, {
    contents: 'read',
    issues: 'write',
  })
  for (const [name, job] of Object.entries(workflow.jobs))
    if (name !== 'report') assert.equal(job.permissions, undefined, name)
})

test('the report job tracks each reported row after writing the report', () => {
  const report = workflow.jobs.report
  const track = stepThatRuns(report, 'flaky-issues.mjs')
  // The aggregate step exits non-zero on a reported row, which is exactly the
  // night an issue has to be filed.
  assert.equal(track.if, 'always()')
  assert.equal(track.env.GITHUB_TOKEN, '${{ github.token }}')
  assert.equal(
    track.env.DEFAULT_BRANCH,
    '${{ github.event.repository.default_branch }}',
  )
  assert.ok(
    stepIndex(report, 'flaky-issues.mjs') >
      stepIndex(report, 'flaky-report.mjs'),
  )
})

test('the detector never cancels a run in progress', () => {
  assert.deepEqual(workflow.concurrency, {
    group: 'flaky-detector',
    'cancel-in-progress': false,
  })
})
