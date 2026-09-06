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

/** Coordinated implementation history can narrow a changed target only from a
 * jointly completed pair. A same-HEAD rerun keeps the prior requested base so
 * it reads the full range again. */

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

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right)
}

function latestRound(state) {
  if (state?.schema_version !== 1 || !Array.isArray(state.rounds))
    return undefined
  return state.rounds.at(-1)
}

/**
 * The coordinator is the only writer of final implementation-review history.
 * A pair is reusable only when both reviewer files contain the same completed
 * target and the exact final model/effort profile. Older per-reviewer records
 * have no profile or base and therefore remain intermediate/legacy evidence.
 */
export function matchingPairHistory({ codexState, claudeState, profile } = {}) {
  const codex = latestRound(codexState)
  const claude = latestRound(claudeState)
  if (
    !codex ||
    !claude ||
    !codex.head ||
    codex.head !== claude.head ||
    !codex.base ||
    codex.base !== claude.base ||
    !codex.profile ||
    !claude.profile ||
    !sameJson(codex.profile, profile) ||
    !sameJson(claude.profile, profile)
  )
    return undefined
  return {
    head: codex.head,
    base: codex.base,
    profile: codex.profile,
  }
}

/** Resolve the base for a coordinated final pair. */
export function resolvePairReviewBase({
  codexState,
  claudeState,
  profile,
  defaultBase,
  explicitBase,
  head,
  run = commandOutput,
} = {}) {
  if (explicitBase)
    return { base: explicitBase, previousHead: null, reused: false }
  const pair = matchingPairHistory({ codexState, claudeState, profile })
  if (!pair) return { base: defaultBase, previousHead: null, reused: false }
  // A same-HEAD rerun must read the original requested range again. Reusing
  // the previous base preserves that range without treating an empty diff as
  // a successful review.
  if (pair.head === head && baseIsReachable(pair.base, run))
    return { base: pair.base, previousHead: pair.head, reused: true }
  if (
    isStrictAncestor(pair.head, head, run) &&
    !rangeIsEmpty(pair.head, head, run)
  )
    return { base: pair.head, previousHead: pair.head, reused: true }
  // The prior pair may have been rebased or garbage-collected, or may belong
  // to a divergent line. Start from the ordinary default in all such cases.
  return { base: defaultBase, previousHead: null, reused: false }
}

/** A non-empty range does not prove that the prior target is on this line;
 * divergent commits also produce a non-empty `base..head` count. */
export function isStrictAncestor(base, head, run = commandOutput) {
  if (!base || !head || base === head) return false
  try {
    run('git', ['merge-base', '--is-ancestor', base, head])
    return true
  } catch {
    return false
  }
}

export function recordRound(state, { head, reviewer, base, profile }) {
  const round = { head, reviewer, at: new Date().toISOString() }
  if (base !== undefined) round.base = base
  if (profile !== undefined) round.profile = profile
  return {
    schema_version: 1,
    rounds: [...(Array.isArray(state?.rounds) ? state.rounds : []), round],
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
