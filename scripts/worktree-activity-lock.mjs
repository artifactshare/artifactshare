import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { join, resolve } from 'node:path'
import { acquireSpecLock } from './spec-review-gate.mjs'

// One activity at a time per worktree: an implementation gate verifies that
// HEAD and the worktree do not change while it runs, and a screen capture,
// walkthrough, or critique running in the same worktree at the same time
// invalidates it (and the capture's own HEAD check). The lock lives in the
// shared Git common directory, keyed by the worktree path, and is held by a
// child process that exits with its parent, like the spec review lock.

function commandOutput(file, args) {
  return execFileSync(file, args, { encoding: 'utf8' }).trim()
}

export function activityLockPath(run = commandOutput) {
  const toplevel = resolve(run('git', ['rev-parse', '--show-toplevel']))
  const common = resolve(run('git', ['rev-parse', '--git-common-dir']))
  const key = createHash('sha256').update(toplevel).digest('hex').slice(0, 16)
  return join(common, 'artifactshare', 'worktree-activity', `${key}.lock`)
}

/**
 * Acquire the worktree activity lock for `activity` (a short label used in
 * the contention message). Resolves to a release function; rejects at once
 * when another activity holds the lock.
 */
export async function acquireActivityLock(
  activity,
  { run = commandOutput, acquire = acquireSpecLock } = {},
) {
  const lockPath = activityLockPath(run)
  try {
    return await acquire(lockPath)
  } catch (error) {
    const reason = (
      error instanceof Error ? error.message : String(error)
    ).trim()
    // Only a held lock is contention; a missing lockf/flock or a spawn
    // failure is reported as what it is.
    if (
      !/already holds|lockf|flock|resource temporarily unavailable/iu.test(
        reason,
      )
    )
      throw error
    throw new Error(
      `Cannot start ${activity}: another review, capture, or critique is running in this worktree (${reason}). Wait for it to finish; the implementation gate, screen capture, walkthrough capture, and critique run one at a time per worktree.`,
    )
  }
}
