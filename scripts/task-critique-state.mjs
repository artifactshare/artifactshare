import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join, resolve } from 'node:path'
import { writeRounds } from './review-rounds.mjs'

/** The latest UI critique completion for a branch, read by `pr:ready`.
 *
 * One small file per branch under the Git common directory, so linked
 * worktrees share it like the implementation review rounds. It is not a
 * receipt or attempt log: it holds only the critiqued HEAD, whether every
 * selected layer completed, and SHA-256 identities of the validated capture
 * roots. Reviewer output, prompts, sources, scope judgments, dispositions and
 * plaintext capture paths never enter it. */

const schemaVersion = 1
const recordKeys = [
  'schema_version',
  'head',
  'completed',
  'walkthroughRoot',
  'screenRoots',
]
const headPattern = /^[0-9a-f]{40}$/u
const identityPattern = /^[0-9a-f]{64}$/u

function commandOutput(file, args) {
  return execFileSync(file, args, { encoding: 'utf8' }).trim()
}

/** A relative common directory (`.git` in the main worktree) is relative to
 * the repository the command ran in, not to this process's cwd. */
export function critiqueStatePath(
  branch,
  { run = commandOutput, repo = process.cwd() } = {},
) {
  const key = createHash('sha256').update(branch).digest('hex').slice(0, 32)
  return join(
    resolve(repo, run('git', ['rev-parse', '--git-common-dir'])),
    'artifactshare',
    'task-critique',
    `${key}.json`,
  )
}

/** Identifies a validated canonical capture root without storing its path. */
export function captureRootIdentity(canonicalRoot) {
  return createHash('sha256').update(canonicalRoot).digest('hex')
}

function validRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const keys = Object.keys(value)
  if (
    keys.length !== recordKeys.length ||
    !recordKeys.every((key) => Object.hasOwn(value, key))
  )
    return false
  return (
    value.schema_version === schemaVersion &&
    typeof value.head === 'string' &&
    headPattern.test(value.head) &&
    typeof value.completed === 'boolean' &&
    (value.walkthroughRoot === null ||
      (typeof value.walkthroughRoot === 'string' &&
        identityPattern.test(value.walkthroughRoot))) &&
    Array.isArray(value.screenRoots) &&
    value.screenRoots.every(
      (item) => typeof item === 'string' && identityPattern.test(item),
    ) &&
    (value.walkthroughRoot !== null || value.screenRoots.length > 0)
  )
}

/** Absent, unreadable, malformed or unsupported state is no evidence. */
export function readCritiqueRecord(path) {
  let value
  try {
    value = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return undefined
  }
  return validRecord(value) ? value : undefined
}

export function critiqueCompletionRecord({
  head,
  walkthroughRoot,
  screenRoots = [],
}) {
  const record = {
    schema_version: schemaVersion,
    head,
    completed: true,
    walkthroughRoot: walkthroughRoot
      ? captureRootIdentity(walkthroughRoot)
      : null,
    screenRoots: screenRoots.map(captureRootIdentity),
  }
  if (!validRecord(record))
    throw new Error('UI critique completion record is invalid.')
  return record
}

/** Replaces the branch's record atomically with private modes. A failed write
 * throws and leaves the previous record in place. A detached HEAD has no
 * branch to key the record by, so nothing is written and `undefined` is
 * returned. */
export function writeCritiqueRecord(
  record,
  { run = commandOutput, repo = process.cwd() } = {},
) {
  if (!validRecord(record))
    throw new Error('UI critique completion record is invalid.')
  const branch = run('git', ['branch', '--show-current'])
  if (!branch) return undefined
  const path = critiqueStatePath(branch, { run, repo })
  writeRounds(path, record)
  return path
}
