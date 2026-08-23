import assert from 'node:assert/strict'
import test from 'node:test'
import { checkTaskLedger } from './check-task-ledger.mjs'
import { personas, tasks } from './task-ledger.mjs'

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

test('requires an explicit completion self-confirmation', () => {
  const tasksWithoutConfirmation = Array.from({ length: 8 }, (_, index) => ({
    ...fixtureTask({ id: `task-${index}` }),
    confirmation: index === 0 ? '' : fixtureTask().confirmation,
  }))
  assert.ok(
    checkTaskLedger({ ledgerTasks: tasksWithoutConfirmation }).includes(
      'task-0: confirmation required',
    ),
  )
})

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

test('rejects a task referencing an unknown persona', () => {
  const failures = checkTaskLedger(
    options(
      Array.from({ length: 8 }, (_, index) =>
        fixtureTask({
          id: `task-${index}`,
          persona: index === 0 ? 'missing-persona' : tasks[0].persona,
        }),
      ),
    ),
  )
  assert.deepEqual(failures, ['task-0: unknown persona missing-persona'])
})

test('rejects an incomplete persona registry', () => {
  const failures = checkTaskLedger({
    ...options(
      Array.from({ length: 8 }, (_, index) =>
        fixtureTask({ id: `task-${index}`, persona: 'fixture-persona' }),
      ),
    ),
    ledgerPersonas: [
      {
        id: 'fixture-persona',
        name: '',
        summary: 'summary',
        mediation: 'walk-in',
        auth: 'nobody',
      },
    ],
  })
  assert.deepEqual(failures, [
    'fixture-persona: persona name required',
    'fixture-persona: invalid persona mediation walk-in',
    'fixture-persona: unknown persona auth nobody',
  ])
})

test('requires a non-empty persona registry', () =>
  assert.equal(
    checkTaskLedger({
      ...options(
        Array.from({ length: 8 }, (_, index) =>
          fixtureTask({ id: `task-${index}` }),
        ),
      ),
      ledgerPersonas: [],
    })[0],
    'personas required',
  ))

test('reports a non-object persona entry without throwing', () =>
  assert.equal(
    checkTaskLedger({
      ...options(
        Array.from({ length: 8 }, (_, index) =>
          fixtureTask({ id: `task-${index}` }),
        ),
      ),
      ledgerPersonas: [null],
    })[0],
    '<invalid-persona-entry>: persona object required',
  ))

test('reports a non-array persona registry without throwing', () =>
  assert.equal(
    checkTaskLedger({
      ...options(
        Array.from({ length: 8 }, (_, index) =>
          fixtureTask({ id: `task-${index}` }),
        ),
      ),
      ledgerPersonas: {},
    })[0],
    'personas required',
  ))

test('rejects a task without a persona even when a registry entry lacks an id', () => {
  const failures = checkTaskLedger({
    ...options(
      Array.from({ length: 8 }, (_, index) =>
        fixtureTask({ id: `task-${index}`, persona: undefined }),
      ),
    ),
    ledgerPersonas: [
      {
        name: 'name',
        summary: 'summary',
        mediation: 'mixed',
        auth: 'anonymous',
      },
    ],
  })
  assert.ok(failures.includes('<missing-persona-id>: persona id required'))
  assert.ok(failures.includes('task-0: unknown persona undefined'))
})

test('ships a registry that covers every ledger task', () => {
  const ids = new Set(personas.map((persona) => persona.id))
  for (const task of tasks) assert.ok(ids.has(task.persona), task.id)
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
