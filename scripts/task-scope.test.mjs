import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  MAX_SCOPE_BYTES,
  admitTaskCandidate,
  currentTaskBranch,
  initializeTaskScope,
  readScopeFile,
  readTaskScopeState,
  taskScopeContext,
  taskScopePaths,
  taskScopeStatus,
  validateTaskScope,
} from './task-scope.mjs'

const scope = {
  schema_version: 1,
  objective: 'Stop implementation review after one correction.',
  failures: [
    { id: 'I1', scenario: 'A third distinct candidate is submitted.' },
    { id: 'I2', scenario: 'A session resumes on the same task branch.' },
  ],
  trusted_inputs: ['An attached Git branch', 'A clean committed HEAD'],
  manual_recovery: 'Start a fresh branch and initialize a fresh scope.',
  max_corrections: 1,
}

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'task-scope-'))
  const run = (_file, args) => {
    if (args.join(' ') === 'rev-parse --git-common-dir') return directory
    throw new Error(`Unexpected git call: ${args.join(' ')}`)
  }
  return { directory, run }
}

test('accepts only the bounded strict scope schema', () => {
  assert.deepEqual(validateTaskScope(scope), scope)
  assert.throws(
    () => validateTaskScope({ ...scope, extra: true }),
    /fields must be exactly/u,
  )
  assert.throws(
    () => validateTaskScope({ ...scope, failures: [] }),
    /one to three/u,
  )
  assert.throws(
    () =>
      validateTaskScope({
        ...scope,
        failures: [{ id: 'I2', scenario: 'wrong' }],
      }),
    /must use id I1/u,
  )
  const directory = mkdtempSync(join(tmpdir(), 'task-scope-input-'))
  try {
    const path = join(directory, 'scope.json')
    writeFileSync(path, 'x'.repeat(MAX_SCOPE_BYTES + 1))
    assert.throws(() => readScopeFile(path), /exceeds 4096 bytes/u)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('keys state by the exact attached branch in shared Git state', () => {
  assert.equal(
    currentTaskBranch(() => 'fix/exact-branch\n'),
    'fix/exact-branch',
  )
  assert.throws(() => currentTaskBranch(() => '\n'), /attached branch/u)
  const { directory, run } = fixture()
  try {
    const first = taskScopePaths('fix/one', run)
    const second = taskScopePaths('fix/two', run)
    assert.equal(
      first.state.startsWith(join(directory, 'artifactshare', 'task-scopes')),
      true,
    )
    assert.notEqual(first.state, second.state)
    assert.match(first.state, /[0-9a-f]{64}\.json$/u)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('initialization is immutable and status survives a later read', () => {
  const { directory, run } = fixture()
  try {
    const initialized = initializeTaskScope('feature', scope, run)
    assert.deepEqual(initializeTaskScope('feature', scope, run), initialized)
    assert.throws(
      () =>
        initializeTaskScope('feature', { ...scope, objective: 'changed' }, run),
      /SCOPE_IMMUTABLE/u,
    )
    assert.deepEqual(taskScopeStatus(readTaskScopeState('feature', run)), {
      status: 'ACTIVE',
      objective: scope.objective,
      failures: scope.failures,
      trusted_inputs: scope.trusted_inputs,
      manual_recovery: scope.manual_recovery,
      admitted_candidates: 0,
      candidate_limit: 2,
    })
    assert.throws(() => readTaskScopeState('missing', run), /NO_ACTIVE_SCOPE/u)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('admits the initial HEAD and one correction and rejects a third HEAD', () => {
  const { directory, run } = fixture()
  const first = 'a'.repeat(40)
  const correction = 'b'.repeat(40)
  try {
    initializeTaskScope('feature', scope, run)
    admitTaskCandidate('feature', first, run)
    assert.deepEqual(admitTaskCandidate('feature', first, run).admitted_heads, [
      first,
    ])
    assert.deepEqual(
      admitTaskCandidate('feature', correction, run).admitted_heads,
      [first, correction],
    )
    assert.throws(
      () => admitTaskCandidate('feature', 'c'.repeat(40), run),
      /OBJECTIVE_REBASE_REQUIRED/u,
    )
    assert.deepEqual(readTaskScopeState('feature', run).admitted_heads, [
      first,
      correction,
    ])
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('generates reviewer context only from the immutable scope', () => {
  const context = taskScopeContext({ scope })
  assert.match(context, /I1: A third distinct candidate/u)
  assert.match(context, /blocker only when it names one failure ID/u)
  assert.match(context, /## Dispositions\n\nNone yet/u)
})
