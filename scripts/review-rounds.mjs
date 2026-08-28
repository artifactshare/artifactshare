import { execFileSync } from 'node:child_process'
import {
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'

/** Implementation review re-read the whole change every round, so the surface
 * grew with each fix commit and the round count had no reason to fall. A later
 * round asks a narrower question — did the fixes break something — so it reads
 * only what changed since the round before it. */

function commandOutput(file, args) {
  return execFileSync(file, args, { encoding: 'utf8' }).trim()
}

/** One file per branch and reviewer. The workflow runs both reviewers in
 * parallel, so a shared file is a read-modify-write race whose loser silently
 * drops the other's rounds — and a lock would be machinery bought to protect
 * data that never had to be shared. Branch names are hashed rather than
 * sanitised, because replacing separators makes `fix/a-b` and `fix_a-b` collide
 * although they are different branches. */
export function roundsPath(branch, reviewer, run = commandOutput) {
  const key = createHash('sha256')
    .update(`${reviewer}\u0000${branch}`)
    .digest('hex')
    .slice(0, 32)
  return join(
    resolve(run('git', ['rev-parse', '--git-common-dir'])),
    'artifactshare',
    'review-rounds',
    `${key}.json`,
  )
}

/** Every rounds file for a branch, so deleting the branch clears all of them. */
export function roundsPathsForBranch(branch, run = commandOutput) {
  return ['codex', 'claude'].map((reviewer) =>
    roundsPath(branch, reviewer, run),
  )
}

export function readRounds(path) {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    if (parsed?.schema_version !== 1 || !Array.isArray(parsed.rounds))
      return { schema_version: 1, rounds: [] }
    return parsed
  } catch {
    return { schema_version: 1, rounds: [] }
  }
}

export function writeRounds(path, state) {
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

/** The first round reads the whole change against its base. Every later round
 * reads only the commits added since **that reviewer's** last head: the two
 * reviewers run independently, and keying rounds by branch alone hands the
 * second one an empty range that reads as vacuously clean. An explicit --base
 * always wins, so a deliberate full re-read stays available. */
export function resolveReviewBase({
  state,
  reviewer,
  defaultBase,
  explicitBase,
  head,
}) {
  const mine = state.rounds
  const round = mine.length + 1
  if (explicitBase) return { base: explicitBase, round, upToDate: false }
  const last = mine[mine.length - 1]
  const base = last ? last.head : defaultBase
  // Nothing new since this reviewer last read the branch. An equal base is the
  // common case; an ancestor head (after a reset) yields the same empty range,
  // and reviewing it would report clean without having looked at anything, so
  // the caller decides emptiness from the range itself.
  return { base, round, previousHead: last?.head ?? null }
}

export function recordRound(state, { head, reviewer }) {
  return {
    schema_version: 1,
    rounds: [...state.rounds, { head, reviewer, at: new Date().toISOString() }],
  }
}

/** A recorded head can vanish: a rebase, a gc, or a later branch reusing the
 * name. Reviewing against it would either abort in git or, worse, produce an
 * empty range that reads as clean. */
export function baseIsReachable(base, run = commandOutput) {
  if (!base) return false
  try {
    run('git', ['cat-file', '-e', `${base}^{commit}`])
    return true
  } catch {
    return false
  }
}

/** Empty when the range holds no commits — equal heads, or a head that is an
 * ancestor of the one last reviewed. */
export function rangeIsEmpty(base, head, run = commandOutput) {
  if (!base || !head) return false
  if (base === head) return true
  try {
    return run('git', ['rev-list', '--count', `${base}..${head}`]) === '0'
  } catch {
    return false
  }
}
