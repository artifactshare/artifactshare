import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import YAML from 'yaml'

const workflow = YAML.parse(
  fs.readFileSync('.github/workflows/flaky-detector.yml', 'utf8'),
)

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
    report.steps.at(-2).run,
    /flaky-report\.mjs.*REPETITIONS.*GITHUB_SHA/u,
  )
  assert.equal(report.steps.at(-1).if, 'always()')
  assert.equal(
    workflow.jobs.worker.steps.at(-1).if,
    'always()',
    'workers upload their results even when the suite fails',
  )
})

test('the detector never cancels a run in progress', () => {
  assert.deepEqual(workflow.concurrency, {
    group: 'flaky-detector',
    'cancel-in-progress': false,
  })
})
