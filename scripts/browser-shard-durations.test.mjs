import assert from 'node:assert/strict'
import test from 'node:test'
import {
  medianDurations,
  parseFileDurations,
} from './ci/browser-shard-durations.mjs'

test('reads file durations from colored Vitest job logs', () => {
  const log = [
    '2026-11-27T15:45:00.0000000Z \u001b[32m✓\u001b[39m \u001b[30m\u001b[43m firefox \u001b[49m\u001b[39m app/lib/usercontent-delivery.behavior.browser.test.tsx \u001b[2m(\u001b[22m\u001b[2m1 test\u001b[22m\u001b[2m)\u001b[22m\u001b[33m 113754\u001b[2mms\u001b[22m\u001b[39m',
    '2026-11-27T15:45:01.0000000Z    ✓ real cross-site Worker delivery 113753ms',
    '2026-11-27T15:45:02.0000000Z  ❯  chromium  app/lib/pdf-viewer.behavior.browser.test.tsx (36 tests | 1 failed) 84583ms',
  ].join('\n')
  assert.deepEqual(parseFileDurations(log), [
    {
      project: 'firefox',
      file: 'app/lib/usercontent-delivery.behavior.browser.test.tsx',
      milliseconds: 113754,
    },
    {
      project: 'chromium',
      file: 'app/lib/pdf-viewer.behavior.browser.test.tsx',
      milliseconds: 84583,
    },
  ])
})

test('keeps the median of each file and a positive duration', () => {
  const file = 'app/a.behavior.browser.test.tsx'
  assert.deepEqual(
    medianDurations([
      { project: 'webkit', file, milliseconds: 300 },
      { project: 'webkit', file, milliseconds: 100 },
      { project: 'webkit', file, milliseconds: 200 },
      { project: 'chromium', file, milliseconds: 0 },
    ]),
    { chromium: { [file]: 1 }, webkit: { [file]: 200 } },
  )
})
