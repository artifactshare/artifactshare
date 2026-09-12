import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  MAX_SCOPE_BYTES,
  admitTaskCandidate,
  currentTaskBranch,
  initializeTaskScope,
  main,
  readScopeFile,
  readTaskScopeState,
  taskScopeContext,
  taskScopePaths,
  taskScopeStatus,
  validateTaskScope,
} from './task-scope.mjs'

const scope = {
  schema_version: 1,
  objective: 'Review every correction against one immutable scope.',
  failures: [
    { id: 'I1', scenario: 'A third distinct candidate is submitted.' },
    { id: 'I2', scenario: 'A session resumes on the same task branch.' },
  ],
  trusted_inputs: ['An attached Git branch', 'A clean committed HEAD'],
  manual_recovery: 'Start a fresh branch and initialize a fresh scope.',
}

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'task-scope-'))
  const run = (_file, args) => {
    if (args.join(' ') === 'rev-parse --git-common-dir') return directory
    throw new Error(`Unexpected git call: ${args.join(' ')}`)
  }
  return { directory, run }
}

test('accepts only the strict scope schema without a correction limit', () => {
  assert.deepEqual(validateTaskScope(scope), scope)
  assert.throws(
    () => validateTaskScope({ ...scope, extra: true }),
    /fields must be exactly/u,
  )
  assert.throws(
    () => validateTaskScope({ ...scope, max_corrections: 1 }),
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
    })
    assert.throws(() => readTaskScopeState('missing', run), /NO_ACTIVE_SCOPE/u)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('admits third and later distinct HEADs and allows same-HEAD reruns', () => {
  const { directory, run } = fixture()
  const first = 'a'.repeat(40)
  const corrections = ['b', 'c', 'd'].map((value) => value.repeat(40))
  try {
    initializeTaskScope('feature', scope, run)
    admitTaskCandidate('feature', first, run)
    assert.deepEqual(admitTaskCandidate('feature', first, run).admitted_heads, [
      first,
    ])
    for (const correction of corrections)
      admitTaskCandidate('feature', correction, run)
    const admitted = [first, ...corrections]
    assert.deepEqual(
      readTaskScopeState('feature', run).admitted_heads,
      admitted,
    )
    assert.deepEqual(
      admitTaskCandidate('feature', corrections[1], run).admitted_heads,
      admitted,
    )
    assert.deepEqual(taskScopeStatus(readTaskScopeState('feature', run)), {
      status: 'ACTIVE',
      objective: scope.objective,
      failures: scope.failures,
      trusted_inputs: scope.trusted_inputs,
      manual_recovery: scope.manual_recovery,
      admitted_candidates: 4,
    })
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('normalizes the obsolete persisted correction limit without changing scope', () => {
  const { directory, run } = fixture()
  try {
    initializeTaskScope('feature', scope, run)
    const path = taskScopePaths('feature', run).state
    const legacy = JSON.parse(readFileSync(path, 'utf8'))
    legacy.scope.max_corrections = 1
    writeFileSync(path, `${JSON.stringify(legacy)}\n`)

    assert.deepEqual(readTaskScopeState('feature', run).scope, scope)
    admitTaskCandidate('feature', 'a'.repeat(40), run)
    const persisted = JSON.parse(readFileSync(path, 'utf8'))
    assert.deepEqual(persisted.scope, scope)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('generates reviewer context from immutable scope and supplied dispositions', () => {
  const initial = taskScopeContext({ scope })
  const dispositions =
    '- fixed: prior finding and change\n- deferred: later review\n'
  const corrected = taskScopeContext({ scope }, dispositions)
  assert.match(initial, /I1: A third distinct candidate/u)
  assert.match(initial, /blocker only when it names one failure ID/u)
  assert.match(initial, /## Dispositions\n\nNone yet/u)
  assert.match(corrected, /- fixed: prior finding and change/u)
  assert.match(corrected, /- deferred: later review/u)
  assert.doesNotMatch(corrected, /None yet/u)
  assert.equal(
    corrected.slice(0, corrected.indexOf('## Dispositions')),
    initial.slice(0, initial.indexOf('## Dispositions')),
  )
  assert.throws(
    () => taskScopeContext({ scope }, '- needs-work: unresolved finding\n'),
    /Every item under Dispositions/u,
  )
})

test('status reads atomic state without waiting for the review lock', async () => {
  const { directory, run } = fixture()
  try {
    initializeTaskScope('feature', scope, run)
    let acquired = false
    const output = []
    const code = await main({
      argv: ['status'],
      run: (file, args) =>
        args.join(' ') === 'branch --show-current'
          ? 'feature'
          : run(file, args),
      acquire: () => {
        acquired = true
        throw new Error('status must not acquire the branch lock')
      },
      log: (value) => output.push(value),
    })
    assert.equal(code, 0)
    assert.equal(acquired, false)
    assert.equal(JSON.parse(output[0]).objective, scope.objective)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
