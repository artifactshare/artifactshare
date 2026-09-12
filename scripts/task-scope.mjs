#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import {
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { acquireFileLock } from './os-file-lock.mjs'
import { assertImplementationContext } from './implementation-review-input.mjs'

const MAX_SCOPE_BYTES = 4 * 1024
const SCOPE_KEYS = [
  'failures',
  'manual_recovery',
  'objective',
  'schema_version',
  'trusted_inputs',
]
const LEGACY_SCOPE_KEYS = [...SCOPE_KEYS, 'max_corrections'].sort()

function commandOutput(file, args) {
  return execFileSync(file, args, { encoding: 'utf8' }).trim()
}

export function currentTaskBranch(run = commandOutput) {
  const branch = run('git', ['branch', '--show-current']).trim()
  if (!branch)
    throw new Error('NO_ACTIVE_SCOPE: task scope requires an attached branch.')
  return branch
}

function branchKey(branch) {
  return createHash('sha256').update(branch, 'utf8').digest('hex')
}

export function taskScopePaths(branch, run = commandOutput) {
  const root = join(
    resolve(run('git', ['rev-parse', '--git-common-dir'])),
    'artifactshare',
    'task-scopes',
  )
  const key = branchKey(branch)
  return {
    state: join(root, `${key}.json`),
    lock: join(root, 'locks', `${key}.lock`),
  }
}

function nonempty(value, label) {
  if (typeof value !== 'string' || !value.trim())
    throw new Error(`Task scope ${label} must be nonempty text.`)
  return value.trim()
}

function validateTaskScopeShape(value, { allowLegacyLimit = false } = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Task scope must be a JSON object.')
  const keys = Object.keys(value).sort()
  const expectedKeys = [...SCOPE_KEYS].sort()
  const legacy =
    allowLegacyLimit && keys.join(',') === LEGACY_SCOPE_KEYS.join(',')
  if (!legacy && keys.join(',') !== expectedKeys.join(','))
    throw new Error(
      `Task scope fields must be exactly: ${expectedKeys.join(', ')}.`,
    )
  if (value.schema_version !== 1)
    throw new Error('Task scope schema_version must be 1.')
  if (legacy && value.max_corrections !== 1)
    throw new Error('Task scope max_corrections must be 1.')
  if (
    !Array.isArray(value.failures) ||
    value.failures.length < 1 ||
    value.failures.length > 3
  )
    throw new Error('Task scope failures must contain one to three items.')
  const failures = value.failures.map((failure, index) => {
    if (
      !failure ||
      typeof failure !== 'object' ||
      Array.isArray(failure) ||
      Object.keys(failure).sort().join(',') !== 'id,scenario' ||
      failure.id !== `I${index + 1}`
    )
      throw new Error(
        `Task scope failure ${index + 1} must use id I${index + 1}.`,
      )
    return {
      id: failure.id,
      scenario: nonempty(failure.scenario, `${failure.id} scenario`),
    }
  })
  if (
    !Array.isArray(value.trusted_inputs) ||
    value.trusted_inputs.length < 1 ||
    value.trusted_inputs.length > 3
  )
    throw new Error(
      'Task scope trusted_inputs must contain one to three items.',
    )
  return {
    schema_version: 1,
    objective: nonempty(value.objective, 'objective'),
    failures,
    trusted_inputs: value.trusted_inputs.map((item, index) =>
      nonempty(item, `trusted_inputs item ${index + 1}`),
    ),
    manual_recovery: nonempty(value.manual_recovery, 'manual_recovery'),
  }
}

export function validateTaskScope(value) {
  return validateTaskScopeShape(value)
}

export function readScopeFile(path) {
  if (statSync(path).size > MAX_SCOPE_BYTES)
    throw new Error(`Task scope exceeds ${MAX_SCOPE_BYTES} bytes.`)
  return validateTaskScope(JSON.parse(readFileSync(path, 'utf8')))
}

function writeState(path, state) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`
  try {
    writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    })
    renameSync(temporary, path)
  } finally {
    rmSync(temporary, { force: true })
  }
}

export function readTaskScopeState(branch, run = commandOutput) {
  const path = taskScopePaths(branch, run).state
  let state
  try {
    state = JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    if (error?.code === 'ENOENT')
      throw new Error(
        `NO_ACTIVE_SCOPE: initialize a task scope for branch ${branch}.`,
      )
    throw error
  }
  if (
    !state ||
    typeof state !== 'object' ||
    Array.isArray(state) ||
    state.schema_version !== 1 ||
    state.branch !== branch ||
    !Array.isArray(state.admitted_heads) ||
    state.admitted_heads.some((head) => !/^[0-9a-f]{40}$/u.test(head))
  )
    throw new Error(`Task scope state for branch ${branch} is invalid.`)
  // Scopes persisted before correction limits were removed remain usable. The
  // obsolete limit is normalized away and is not written on the next update.
  const scope = validateTaskScopeShape(state.scope, { allowLegacyLimit: true })
  return {
    schema_version: 1,
    branch,
    scope,
    admitted_heads: [...new Set(state.admitted_heads)],
  }
}

export function initializeTaskScope(branch, scope, run = commandOutput) {
  const path = taskScopePaths(branch, run).state
  const expected = validateTaskScope(scope)
  let current
  try {
    current = readTaskScopeState(branch, run)
  } catch (error) {
    if (!error.message.startsWith('NO_ACTIVE_SCOPE:')) throw error
  }
  if (current) {
    if (JSON.stringify(current.scope) !== JSON.stringify(expected))
      throw new Error(
        'SCOPE_IMMUTABLE: start a fresh branch to use a different task scope.',
      )
    return current
  }
  const state = {
    schema_version: 1,
    branch,
    scope: expected,
    admitted_heads: [],
  }
  writeState(path, state)
  return state
}

export function admitTaskCandidate(branch, head, run = commandOutput) {
  if (!/^[0-9a-f]{40}$/u.test(head))
    throw new Error('Task candidate HEAD is invalid.')
  const state = readTaskScopeState(branch, run)
  if (state.admitted_heads.includes(head)) return state
  state.admitted_heads.push(head)
  writeState(taskScopePaths(branch, run).state, state)
  return state
}

export function taskScopeStatus(state) {
  return {
    status: 'ACTIVE',
    objective: state.scope.objective,
    failures: state.scope.failures,
    trusted_inputs: state.scope.trusted_inputs,
    manual_recovery: state.scope.manual_recovery,
    admitted_candidates: state.admitted_heads.length,
  }
}

export function taskScopeContext(state, dispositions) {
  if (state.admitted_heads?.length > 1 && dispositions === undefined)
    throw new Error(
      'Correction review requires --dispositions-file; supply prior findings and outcomes (explicit None yet only when there were no prior findings).',
    )
  if (dispositions !== undefined && typeof dispositions !== 'string')
    throw new Error('Implementation review dispositions must be text.')
  const context = [
    '# Objective scope',
    '',
    `Objective: ${state.scope.objective}`,
    '',
    'Named failures:',
    ...state.scope.failures.map(({ id, scenario }) => `- ${id}: ${scenario}`),
    '',
    'Trusted inputs:',
    ...state.scope.trusted_inputs.map((item) => `- ${item}`),
    '',
    `Manual recovery: ${state.scope.manual_recovery}`,
    '',
    'Report a blocker only when it names one failure ID above, a supported scenario within the trusted inputs, and the wrong result. Put broader requests under Scope proposals.',
    '',
    '## Dispositions',
    '',
    dispositions === undefined ? 'None yet' : dispositions,
    '',
  ].join('\n')
  return assertImplementationContext(context)
}

export function acquireTaskScopeLock(
  branch,
  { run = commandOutput, acquire = acquireFileLock } = {},
) {
  return acquire(taskScopePaths(branch, run).lock)
}

function parseArgs(argv) {
  const args = argv[0] === '--' ? argv.slice(1) : argv
  const command = args[0]
  if (!['init', 'status'].includes(command))
    throw new Error(
      'Usage: pnpm task:scope -- <init --scope-file <path>|status>',
    )
  if (command === 'status' && args.length !== 1)
    throw new Error('task:scope status accepts no options.')
  if (command === 'init' && (args.length !== 3 || args[1] !== '--scope-file'))
    throw new Error('task:scope init requires --scope-file <path>.')
  return { command, scopeFile: args[2] }
}

export async function main({
  argv = process.argv.slice(2),
  run = commandOutput,
  acquire = acquireTaskScopeLock,
  log = console.log,
} = {}) {
  const options = parseArgs(argv)
  const branch = currentTaskBranch(run)
  if (options.command === 'status') {
    log(
      JSON.stringify(taskScopeStatus(readTaskScopeState(branch, run)), null, 2),
    )
    return 0
  }
  const release = await acquire(branch, { run })
  try {
    const state = initializeTaskScope(
      branch,
      readScopeFile(options.scopeFile),
      run,
    )
    log(JSON.stringify(taskScopeStatus(state), null, 2))
    return 0
  } finally {
    await release()
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`)
    process.exitCode = 1
  })

export { MAX_SCOPE_BYTES, parseArgs }
