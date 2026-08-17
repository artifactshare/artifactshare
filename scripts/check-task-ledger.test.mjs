import assert from 'node:assert/strict'
import test from 'node:test'
import { checkTaskLedger } from './check-task-ledger.mjs'
import { tasks } from './task-ledger.mjs'

const screen = {
  id: 'fixture',
  states: [{ id: 'default' }, { id: 'error' }],
}

function fixtureTask(overrides = {}) {
  return {
    ...tasks[0],
    id: 'fixture-task',
    flow: tasks[0].flow.map((state) => ({
      ...state,
      screens: ['fixture/default'],
    })),
    ...overrides,
  }
}

const options = (ledgerTasks) => ({
  ledgerTasks,
  ledgerScreens: [screen],
  criteria: ['criterion'],
  procedure: ['procedure'],
})

test('accepts a complete task contract', () =>
  assert.deepEqual(
    checkTaskLedger(
      options(
        Array.from({ length: 8 }, (_, index) =>
          fixtureTask({ id: `task-${index}` }),
        ),
      ),
    ),
    [],
  ))

test('rejects unknown screen and state references', () => {
  const task = fixtureTask()
  task.flow[0].screens = ['fixture/missing', 'missing/default']
  const failures = checkTaskLedger(
    options(
      Array.from({ length: 8 }, (_, index) => ({
        ...task,
        id: `task-${index}`,
      })),
    ),
  )
  assert.deepEqual(failures.slice(0, 2), [
    'task-0/start: unknown screen reference fixture/missing',
    'task-0/start: unknown screen reference missing/default',
  ])
  assert.equal(failures.length, 16)
})

test('requires every flow phase in order', () => {
  const task = fixtureTask({ flow: fixtureTask().flow.slice(1) })
  assert.match(
    checkTaskLedger(
      options(
        Array.from({ length: 8 }, (_, index) => ({
          ...task,
          id: `task-${index}`,
        })),
      ),
    )[0],
    /flow phases must be start, action, pending, success, failure, recovery, next/,
  )
})

test('requires selection and change guidance', () =>
  assert.deepEqual(
    checkTaskLedger({
      ...options(
        Array.from({ length: 8 }, (_, index) =>
          fixtureTask({ id: `task-${index}` }),
        ),
      ),
      criteria: [],
      procedure: [],
    }).slice(0, 2),
    ['selection criteria required', 'change procedure required'],
  ))
