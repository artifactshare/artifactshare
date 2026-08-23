import assert from 'node:assert/strict'
import test from 'node:test'
import {
  championLoopTaskIds,
  checkTaskWalkthroughs,
  taskWalkthroughs,
} from './task-walkthroughs.mjs'

test('covers every champion-loop task with the complete phase sequence', () => {
  assert.deepEqual(checkTaskWalkthroughs(), [])
  assert.deepEqual(
    taskWalkthroughs.map((item) => item.taskId),
    championLoopTaskIds,
  )
})

test('rejects missing phases and an unknown task', () => {
  const walkthroughs = taskWalkthroughs.map((item) => ({
    ...item,
    steps: [...item.steps],
  }))
  walkthroughs[0].steps.pop()
  walkthroughs[1].taskId = 'missing-task'
  const failures = checkTaskWalkthroughs({ walkthroughs })
  assert.ok(failures.some((failure) => failure.includes('walkthrough phases')))
  assert.ok(failures.includes('missing-task: unknown task'))
})

test('rejects an unknown walkthrough action', () => {
  const walkthroughs = taskWalkthroughs.map((item) => ({
    ...item,
    steps: item.steps.map((step) => ({ ...step, action: { ...step.action } })),
  }))
  walkthroughs[0].steps[0].action.kind = 'typo-action'
  assert.ok(
    checkTaskWalkthroughs({ walkthroughs }).includes(
      'return-to-recent-file/start: unknown action typo-action',
    ),
  )
})
