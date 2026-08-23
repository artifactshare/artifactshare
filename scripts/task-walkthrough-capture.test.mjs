import assert from 'node:assert/strict'
import test from 'node:test'
import { parseWalkthroughArgs } from './task-walkthrough-capture.mjs'
import { championLoopTaskIds } from './task-walkthroughs.mjs'

test('selects the champion loop in its canonical order', () => {
  assert.deepEqual(
    parseWalkthroughArgs(['--champion-loop', '--label', 'audit']),
    {
      selected: championLoopTaskIds,
      label: 'audit',
    },
  )
})

test('rejects ambiguous, missing, and unknown selections', () => {
  assert.throws(() => parseWalkthroughArgs([]), /Usage:/)
  assert.throws(
    () =>
      parseWalkthroughArgs([
        '--champion-loop',
        '--task',
        championLoopTaskIds[0],
      ]),
    /Usage:/,
  )
  assert.throws(
    () => parseWalkthroughArgs(['--task', 'missing']),
    /Unknown walkthrough task/,
  )
})
