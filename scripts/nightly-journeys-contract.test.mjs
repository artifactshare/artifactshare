import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import YAML from 'yaml'

const workflow = YAML.parse(
  fs.readFileSync('.github/workflows/nightly-journeys.yml', 'utf8'),
)
const job = workflow.jobs.journeys
const journeyDirectory = '.claude/skills/verify-artifactshare/scripts/journeys'

test('the nightly drives every shipped journey on one stack', () => {
  const shipped = fs
    .readdirSync(journeyDirectory)
    .filter((name) => name.endsWith('.mjs'))
    .map((name) => name.replace(/\.mjs$/u, ''))
    .sort()
  const drive = job.steps.find((step) => step.name === 'Drive every journey')
  const listed = drive.run
    .match(/for journey in ([^;\n]+); do/u)[1]
    .trim()
    .split(/\s+/u)
    .sort()
  assert.deepEqual(listed, shipped)
  assert.equal(
    job.steps.filter((step) => step.run?.includes('stack.mjs up')).length,
    1,
  )
})

test('the nightly stops its stack and keeps the evidence of a run that failed', () => {
  const down = job.steps.find((step) => step.run?.includes('stack.mjs down'))
  assert.equal(down.if, 'always()')
  const upload = job.steps.at(-1)
  assert.match(upload.uses, /^actions\/upload-artifact@[0-9a-f]{40}$/u)
  assert.equal(upload.if, '${{ failure() || cancelled() }}')
  assert.ok(upload.with['retention-days'] <= 7)
  assert.ok(job.steps.indexOf(down) < job.steps.indexOf(upload))
})

test('the nightly drives Chromium from the locked Playwright image', () => {
  const compose = YAML.parse(
    fs.readFileSync('compose.playwright.yml', 'utf8'),
    {
      merge: true,
    },
  )
  assert.equal(job.container.image, compose.services.visual.image)
  assert.equal(job.container.env.PLAYWRIGHT_BROWSERS_PATH, '/ms-playwright')
})

test('the nightly runs on its own schedule and on demand, cancelling nothing', () => {
  assert.ok('workflow_dispatch' in workflow.on)
  assert.match(workflow.on.schedule[0].cron, /^\d+ \d+ \* \* \*$/u)
  assert.deepEqual(workflow.concurrency, {
    group: 'nightly-journeys',
    'cancel-in-progress': false,
  })
})
