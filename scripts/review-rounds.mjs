import { validWorkaroundFinding } from './implementation-review-input.mjs'
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

/** The Git common directory shared by every linked worktree. The main worktree
 * reports a relative `.git`, which is relative to the repository the command
 * ran in, not necessarily to this process's cwd. */
export function gitCommonDir(run = commandOutput, repo = process.cwd()) {
  return resolve(repo, run('git', ['rev-parse', '--git-common-dir']))
}

/** Branch-keyed workflow state under the Git common directory. Keys are
 * hashed rather than sanitised, because replacing separators makes `fix/a-b`
 * and `fix_a-b` collide although they are different branches. */
export function branchStatePath(commonDir, area, key) {
  const digest = createHash('sha256').update(key).digest('hex').slice(0, 32)
  return join(commonDir, 'artifactshare', area, `${digest}.json`)
}

/** One file per branch and reviewer. The workflow runs both reviewers in
 * parallel, so a shared file is a read-modify-write race whose loser silently
 * drops the other's rounds — and a lock would be machinery bought to protect
 * data that never had to be shared. The round-cap consultation is kept under
 * its own `consultation` name beside them. */
export function roundsPathIn(commonDir, branch, reviewer) {
  return branchStatePath(
    commonDir,
    'review-rounds',
    `${reviewer}\u0000${branch}`,
  )
}

export function roundsPath(branch, reviewer, run = commandOutput) {
  return roundsPathIn(gitCommonDir(run), branch, reviewer)
}

/** Every rounds file for a branch, so deleting the branch clears all of them. */
export function roundsPathsForBranch(branch, run = commandOutput) {
  const commonDir = gitCommonDir(run)
  return ['codex', 'claude', 'consultation'].map((reviewer) =>
    roundsPathIn(commonDir, branch, reviewer),
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

/** Atomic replacement: a failed rename leaves the previous file in place and
 * removes the temporary one. */
export function writeRounds(path, state, { rename = renameSync } = {}) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`
  try {
    writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    })
    rename(temporary, path)
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
    codex.pairId !== claude.pairId ||
    !codex.profile ||
    !claude.profile ||
    !sameJson(codex.profile, profile) ||
    !sameJson(claude.profile, profile)
  )
    return undefined
  return {
    ...(codex.pairId && codex.pairId === claude.pairId
      ? { pairId: codex.pairId }
      : {}),
    ...(validWorkaroundRound(codex) && validWorkaroundRound(claude)
      ? {
          workaroundBlockers:
            codex.workaroundBlockers + claude.workaroundBlockers,
          workaroundFindings: {
            codex: codex.workaroundFindings,
            claude: claude.workaroundFindings,
          },
        }
      : {}),
    head: codex.head,
    base: codex.base,
    profile: codex.profile,
    ...(codex.commitBase && codex.commitBase === claude.commitBase
      ? { commitBase: codex.commitBase }
      : {}),
    // Only the blocker counts the gate parsed from both results; a round
    // without one (legacy, or an unparseable result) leaves this undefined.
    ...(Number.isInteger(codex.blockers) &&
    codex.blockers >= 0 &&
    Number.isInteger(claude.blockers) &&
    claude.blockers >= 0
      ? { blockers: codex.blockers + claude.blockers }
      : {}),
  }
}

function validWorkaroundRound(round) {
  return (
    Object.keys(round).every((key) =>
      [
        'head',
        'reviewer',
        'at',
        'base',
        'commitBase',
        'profile',
        'blockers',
        'pairId',
        'workaroundBlockers',
        'workaroundFindings',
      ].includes(key),
    ) &&
    typeof round.pairId === 'string' &&
    !!round.pairId.trim() &&
    Number.isInteger(round.blockers) &&
    round.blockers >= 0 &&
    Number.isInteger(round.workaroundBlockers) &&
    round.workaroundBlockers >= 0 &&
    round.workaroundBlockers <= round.blockers &&
    Array.isArray(round.workaroundFindings) &&
    round.workaroundFindings.length === round.workaroundBlockers &&
    round.workaroundFindings.every(
      (finding) =>
        validWorkaroundFinding(finding) &&
        Object.keys(finding).every((key) =>
          [
            'id',
            'file',
            'line',
            'summary',
            'severity',
            'workaround',
            'root_cause',
            'removing_change',
          ].includes(key),
        ) &&
        (finding.line === undefined ||
          (Number.isInteger(finding.line) && finding.line > 0)) &&
        (finding.summary === undefined ||
          (typeof finding.summary === 'string' && !!finding.summary.trim())) &&
        typeof finding.id === 'string' &&
        !!finding.id.trim() &&
        typeof finding.file === 'string' &&
        !!finding.file.trim(),
    ) &&
    new Set(round.workaroundFindings.map(({ id }) => id)).size ===
      round.workaroundFindings.length
  )
}

export function allWorkaroundPair(pair, head) {
  return (
    pair?.head === head &&
    typeof pair.pairId === 'string' &&
    Number.isInteger(pair.blockers) &&
    pair.blockers > 0 &&
    pair.workaroundBlockers === pair.blockers &&
    !!pair.workaroundFindings
  )
}

export function refusedHead(path, head) {
  try {
    const state = JSON.parse(readFileSync(path, 'utf8'))
    return (
      state.schema_version === 1 &&
      Array.isArray(state.fixHereHeads) &&
      state.fixHereHeads.includes(head)
    )
  } catch {
    return false
  }
}

/** Every pair both reviewer files recorded under `profile`, oldest first. */
export function completedPairs({ codexState, claudeState, profile }) {
  const rounds = (state) =>
    state?.schema_version === 1 && Array.isArray(state.rounds)
      ? state.rounds.filter(
          (round) =>
            round?.head && round.base && sameJson(round.profile, profile),
        )
      : []
  const codex = rounds(codexState)
  return rounds(claudeState).filter((round) =>
    codex.some(
      (other) =>
        other.head === round.head &&
        other.base === round.base &&
        other.pairId === round.pairId,
    ),
  )
}

/** The most recently completed pair under `profile`, whatever its HEAD. */
export function lastCompletedPair({ codexState, claudeState, profile } = {}) {
  const pair = completedPairs({ codexState, claudeState, profile }).at(-1)
  return pair ? { head: pair.head, base: pair.base } : undefined
}

/** Whether `ancestor` is `head` or one of its ancestors. */
export function isAncestorOrSelf(ancestor, head, run = commandOutput) {
  if (!ancestor || !head) return false
  return ancestor === head || isStrictAncestor(ancestor, head, run)
}

/**
 * Whether `pair` and the pairs it narrowed from together reviewed the whole
 * branch. A pair reads `base...head`, which starts at their merge base. It
 * covers the branch when that start is `mergeBase` or one of its ancestors
 * (target-branch commits merged in since are not branch work), or when its
 * base is the HEAD of any earlier completed pair under the same profile whose
 * own chain reaches `mergeBase`. Every completed pair on that HEAD is
 * considered, so a later narrow rerun does not hide an earlier full one. A
 * narrower explicit base that reaches no such pair breaks the chain.
 */
export function pairCoversBranch({
  codexState,
  claudeState,
  profile,
  pair,
  mergeBase,
  run = commandOutput,
} = {}) {
  if (!pair?.head || !pair.base || !mergeBase) return false
  const pairs = completedPairs({ codexState, claudeState, profile })
  const visited = new Set()
  const pending = [pair]
  while (pending.length) {
    const current = pending.pop()
    const key = `${current.head}\u0000${current.base}`
    if (visited.has(key)) continue
    visited.add(key)
    let start
    try {
      start = run('git', ['merge-base', current.base, current.head])
    } catch {
      start = undefined
    }
    if (start && isAncestorOrSelf(start, mergeBase, run)) return true
    pending.push(...pairs.filter((earlier) => earlier.head === current.base))
  }
  return false
}

/** The latest round-cap consultation for a branch: the HEAD it judged, the
 * HEAD of the last completed pair whose unreviewed change it read, its
 * decision and the consulted profile. No consultation prose is stored. */
export const consultationDecisions = Object.freeze([
  'PROCEED',
  'RETURN TO OWNER',
])

export function readConsultation(path, profile) {
  let value
  try {
    value = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return undefined
  }
  const consultation = value?.schema_version === 1 ? value.consultation : null
  if (
    !consultation ||
    typeof consultation.head !== 'string' ||
    !/^[0-9a-f]{40}$/u.test(consultation.head) ||
    typeof consultation.pairHead !== 'string' ||
    !/^[0-9a-f]{40}$/u.test(consultation.pairHead) ||
    !(consultation.kind === 'workarounds'
      ? ['PROCEED', 'FIX HERE'].includes(consultation.decision) &&
        typeof consultation.pairId === 'string' &&
        !!consultation.pairId.trim() &&
        Object.keys(consultation).every((key) =>
          [
            'head',
            'pairHead',
            'pairId',
            'kind',
            'decision',
            'profile',
            'at',
          ].includes(key),
        )
      : (consultation.kind === undefined ||
          consultation.kind === 'round-cap') &&
        consultationDecisions.includes(consultation.decision)) ||
    !sameJson(consultation.profile, profile)
  )
    return undefined
  return consultation
}

export function writeConsultation(
  path,
  { head, pairHead, decision, profile, kind = 'round-cap', pairId },
) {
  let previous
  try {
    previous = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    previous = {}
  }
  const fixHereHeads = new Set(
    Array.isArray(previous.fixHereHeads) ? previous.fixHereHeads : [],
  )
  if (kind === 'workarounds' && decision === 'FIX HERE') fixHereHeads.add(head)
  writeRounds(path, {
    schema_version: 1,
    fixHereHeads: [...fixHereHeads],
    consultation: {
      kind,
      ...(pairId ? { pairId } : {}),
      head,
      pairHead,
      decision,
      profile,
      at: new Date().toISOString(),
    },
  })
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
  const metadata = pair.commitBase ? { commitBase: pair.commitBase } : {}
  // A same-HEAD rerun must read the original requested range again. Reusing
  // the previous base preserves that range without treating an empty diff as
  // a successful review.
  if (pair.head === head && baseIsReachable(pair.base, run))
    return {
      base: pair.base,
      previousHead: pair.head,
      reused: true,
      ...metadata,
    }
  if (
    isStrictAncestor(pair.head, head, run) &&
    !rangeIsEmpty(pair.head, head, run)
  )
    return {
      base: pair.head,
      previousHead: pair.head,
      reused: true,
      ...metadata,
    }
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

export function recordRound(
  state,
  {
    head,
    reviewer,
    base,
    profile,
    commitBase,
    blockers,
    pairId,
    workaroundBlockers,
    workaroundFindings,
  },
) {
  const round = { head, reviewer, at: new Date().toISOString() }
  if (pairId !== undefined) round.pairId = pairId
  if (workaroundBlockers !== undefined)
    round.workaroundBlockers = workaroundBlockers
  if (workaroundFindings !== undefined)
    round.workaroundFindings = workaroundFindings
  if (base !== undefined) round.base = base
  if (commitBase !== undefined) round.commitBase = commitBase
  if (profile !== undefined) round.profile = profile
  if (Number.isInteger(blockers)) round.blockers = blockers
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
