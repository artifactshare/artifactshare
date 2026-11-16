import { readFileSync, renameSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { branchStatePath, writeRounds } from './review-rounds.mjs'

/** The latest UI critique outcome for a branch, read by `pr:ready`.
 *
 * One small file per branch under the Git common directory, beside the
 * implementation review rounds, so linked worktrees share it. It is not a
 * receipt or attempt log: it holds only the critiqued HEAD, whether every
 * selected layer ended with `CRITIQUE_STATUS: COMPLETE`, and SHA-256 identities of the
 * validated capture roots. Reviewer output, prompts, sources, scope judgments,
 * dispositions and plaintext capture paths never enter it. */

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

export function critiqueStatePath(commonDir, branch) {
  return branchStatePath(commonDir, 'task-critique', branch)
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

/** `completed` is false when a layer did not end with `CRITIQUE_STATUS: COMPLETE`:
 * the critique of that HEAD then explicitly does not authorize Ready. */
export function critiqueRecord({
  head,
  completed,
  walkthroughRoot,
  screenRoots = [],
}) {
  const record = {
    schema_version: schemaVersion,
    head,
    completed,
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
 * throws and leaves the previous record in place. */
export function writeCritiqueRecord(
  record,
  { commonDir, branch, rename = renameSync },
) {
  if (!validRecord(record))
    throw new Error('UI critique completion record is invalid.')
  if (!commonDir || !branch)
    throw new Error('UI critique record needs a branch and Git directory.')
  const path = critiqueStatePath(commonDir, branch)
  writeRounds(path, record, { rename })
  return path
}
