import assert from 'node:assert/strict'
import test from 'node:test'
import {
  championLoopTaskIds,
  checkTaskWalkthroughs,
  taskWalkthroughs,
} from './task-walkthroughs.mjs'
import { tasks } from './task-ledger.mjs'

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

test('rejects a walkthrough gap on a task that has a walkthrough', () => {
  const ledgerTasks = tasks.map((task) =>
    task.id === 'republish-updated-file'
      ? { ...task, walkthroughGap: 'stale reason' }
      : task,
  )
  assert.ok(
    checkTaskWalkthroughs({ ledgerTasks }).includes(
      'republish-updated-file: walkthroughGap set on a task with a walkthrough',
    ),
  )
})

test('records why a ledger task has no walkthrough', () => {
  const walked = new Set(taskWalkthroughs.map((item) => item.taskId))
  const gap = tasks.find((task) => task.id === 'recover-interrupted-publish')
  assert.equal(walked.has(gap.id), false)
  assert.ok(gap.walkthroughGap.trim())
})

test('new reactions open the count hint and inspect marked content; later steps use ordinary comments', () => {
  const walkthrough = taskWalkthroughs.find(
    (item) => item.taskId === 'review-new-reactions',
  )
  const phase = (name) =>
    walkthrough.steps.find((step) => step.phase === name).action
  assert.equal(phase('pending').selector, '[data-revisit-comments]')
  assert.equal(
    phase('success').selector,
    '[data-new-comment-thread] [data-new-comment-message]',
  )
  assert.equal(phase('recovery').kind, 'gotoArtifactAndClick')
  assert.match(phase('recovery').selector, /aria-label="Comments"/)
  assert.match(phase('next').selector, /aria-label="Comments"/)
})
