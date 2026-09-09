import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { join, resolve } from 'node:path'
import { acquireFileLock } from './os-file-lock.mjs'
export { ACTIVITY_LOCK_HELD_ENV } from './activity-lock-env.mjs'

// One activity at a time per worktree: an implementation gate or a standalone
// review verifies that HEAD and the worktree do not change while it runs, and
// a screen capture, walkthrough, critique, or second review running in the
// same worktree at the same time invalidates it (and the capture's own HEAD
// check). The lock lives in the
// shared Git common directory, keyed by the worktree path, and is held by a
// child process that exits with its parent, like the spec review lock.

const activeCapabilities = new WeakMap()

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
  { run = commandOutput, acquire = acquireFileLock } = {},
) {
  const worktree = resolve(run('git', ['rev-parse', '--show-toplevel']))
  try {
    const releaseOsLock = await acquire(activityLockPath(run))
    const capability = async () => {
      const active = activeCapabilities.get(capability)
      if (!active) return
      activeCapabilities.delete(capability)
      await releaseOsLock()
    }
    activeCapabilities.set(capability, { worktree })
    return capability
  } catch (error) {
    const reason = (
      error instanceof Error ? error.message : String(error)
    ).trim()
    // Only a held lock is contention (the holder's message or the OS busy
    // error); a missing lockf/flock binary, an unsupported platform, a
    // permission error, or a spawn failure is reported as what it is.
    if (
      !/already (holds|locked)|resource temporarily unavailable|EWOULDBLOCK/iu.test(
        reason,
      )
    )
      throw error
    throw new Error(
      `Cannot start ${activity}: another review, capture, or critique is running in this worktree (${reason}). Wait for it to finish; the implementation and spec gates, standalone review:claude and review:codex, screen capture, walkthrough capture, and critique run one at a time per worktree.`,
    )
  }
}

export function assertActivityLockCapability(capability, run = commandOutput) {
  const active =
    typeof capability === 'function'
      ? activeCapabilities.get(capability)
      : undefined
  if (!active)
    throw new Error('A live worktree activity-lock capability is required.')
  const worktree = resolve(run('git', ['rev-parse', '--show-toplevel']))
  if (active.worktree !== worktree)
    throw new Error('The activity-lock capability belongs to another worktree.')
  return capability
}

export async function releaseActivityLock(release, operationError) {
  try {
    await release()
  } catch (releaseError) {
    if (!operationError) throw releaseError
    const diagnostic =
      releaseError instanceof Error
        ? releaseError.message
        : String(releaseError)
    if (operationError instanceof Error)
      operationError.message += `\nAdditionally, activity-lock release failed: ${diagnostic}`
  }
}

/**
 * Entry-point helper for a command that runs under the activity lock: parse
 * first, so an argument error is reported as itself and a help or dry run
 * takes no lock; then acquire, run `execute(options)` for the exit code, and
 * release even when it throws. Resolves to the exit code.
 */
export async function runUnderActivityLock(
  activity,
  {
    parse,
    needsLock = (options) => !options.help,
    acquire = acquireActivityLock,
    stderr = process.stderr,
  },
  execute,
) {
  try {
    const options = parse()
    const release = needsLock(options)
      ? await acquire(activity)
      : async () => {}
    let result
    let operationError
    try {
      result = await execute(options, release)
    } catch (error) {
      operationError = error
    }
    let releaseError
    try {
      await releaseActivityLock(release, operationError)
    } catch (error) {
      releaseError = error
    }
    if (operationError) {
      throw operationError
    }
    if (releaseError) throw releaseError
    return result
  } catch (error) {
    stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    return 1
  }
}
