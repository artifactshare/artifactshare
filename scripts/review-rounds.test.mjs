import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { finalReviews } from './agent-role-settings.mjs'
import {
  baseIsReachable,
  isStrictAncestor,
  matchingPairHistory,
  rangeIsEmpty,
  readRounds,
  recordRound,
  resolvePairReviewBase,
  roundsPath,
  writeRounds,
} from './review-rounds.mjs'

const first = 'a'.repeat(40)
const second = 'b'.repeat(40)
const third = 'c'.repeat(40)
const defaultBase = 'origin/main'

function state(head, reviewer, base = defaultBase, profile = finalReviews) {
  return {
    schema_version: 1,
    rounds: [{ head, reviewer, base, profile }],
  }
}

function pair(head = first, base = defaultBase, profile = finalReviews) {
  return {
    codexState: state(head, 'codex', base, profile),
    claudeState: state(head, 'claude', base, profile),
  }
}

test('missing, legacy, partial, and mismatched pair state falls back to the default base', () => {
  assert.equal(
    resolvePairReviewBase({
      ...pair(first, defaultBase, { codex: 'old' }),
      profile: finalReviews,
      defaultBase,
      head: second,
    }).base,
    defaultBase,
  )
  assert.equal(
    resolvePairReviewBase({
      codexState: state(first, 'codex'),
      claudeState: undefined,
      profile: finalReviews,
      defaultBase,
      head: second,
    }).base,
    defaultBase,
  )
  assert.equal(
    resolvePairReviewBase({
      codexState: { schema_version: 1, rounds: [{ head: first }] },
      claudeState: { schema_version: 1, rounds: [{ head: first }] },
      profile: finalReviews,
      defaultBase,
      head: second,
    }).base,
    defaultBase,
  )
  assert.equal(
    resolvePairReviewBase({
      ...pair(first),
      claudeState: state(second, 'claude'),
      profile: finalReviews,
      defaultBase,
      head: third,
    }).base,
    defaultBase,
  )
})

test('matching pair history requires the same reviewed target, base, and profile', () => {
  assert.deepEqual(
    matchingPairHistory({ ...pair(first), profile: finalReviews }),
    { head: first, base: defaultBase, profile: finalReviews },
  )
  assert.equal(
    matchingPairHistory({
      ...pair(first),
      claudeState: state(first, 'claude', 'other-base'),
      profile: finalReviews,
    }),
    undefined,
  )
})

test('an explicit base wins over compatible history without consulting it', () => {
  let calls = 0
  const result = resolvePairReviewBase({
    ...pair(first),
    profile: finalReviews,
    defaultBase,
    explicitBase: 'release-base',
    head: second,
    run: () => {
      calls += 1
      throw new Error('history must not be consulted')
    },
  })
  assert.deepEqual(result, {
    base: 'release-base',
    previousHead: null,
    reused: false,
  })
  assert.equal(calls, 0)
})

test('a same-HEAD rerun keeps the original requested range', () => {
  const calls = []
  const result = resolvePairReviewBase({
    ...pair(first, 'original-base'),
    profile: finalReviews,
    defaultBase,
    head: first,
    run: (_file, args) => {
      calls.push(args)
      if (args[0] === 'cat-file') return ''
      throw new Error(`unexpected call: ${args.join(' ')}`)
    },
  })
  assert.deepEqual(result, {
    base: 'original-base',
    previousHead: first,
    reused: true,
  })
  assert.deepEqual(calls, [['cat-file', '-e', 'original-base^{commit}']])
})

test('a changed target narrows only when the prior target is a strict ancestor', () => {
  const result = resolvePairReviewBase({
    ...pair(first, 'original-base'),
    profile: finalReviews,
    defaultBase,
    head: second,
    run: (_file, args) => {
      if (args[0] === 'merge-base') return ''
      if (args[0] === 'rev-list') return '2'
      throw new Error(`unexpected call: ${args.join(' ')}`)
    },
  })
  assert.deepEqual(result, {
    base: first,
    previousHead: first,
    reused: true,
  })

  assert.equal(
    resolvePairReviewBase({
      ...pair(first),
      profile: finalReviews,
      defaultBase,
      head: second,
      run: (_file, args) => {
        if (args[0] === 'merge-base') throw new Error('divergent history')
        throw new Error(`unexpected call: ${args.join(' ')}`)
      },
    }).base,
    defaultBase,
  )
})

test('an unreachable prior target falls back instead of reviewing an empty range', () => {
  assert.equal(
    resolvePairReviewBase({
      ...pair(first, 'original-base'),
      profile: finalReviews,
      defaultBase,
      head: first,
      run: () => {
        throw new Error('missing object')
      },
    }).base,
    defaultBase,
  )
})

test('range and ancestry helpers distinguish empty, strict, and divergent history', () => {
  assert.equal(rangeIsEmpty(first, first), true)
  assert.equal(
    rangeIsEmpty(first, second, () => '0'),
    true,
  )
  assert.equal(
    rangeIsEmpty(first, second, () => '3'),
    false,
  )
  assert.equal(rangeIsEmpty(null, second), false)
  assert.equal(
    isStrictAncestor(first, second, () => ''),
    true,
  )
  assert.equal(
    isStrictAncestor(first, first, () => ''),
    false,
  )
  assert.equal(
    isStrictAncestor(first, second, () => {
      throw new Error('divergent')
    }),
    false,
  )
})

test('a recorded head that no longer exists is not reachable', () => {
  assert.equal(
    baseIsReachable(first, () => ''),
    true,
  )
  assert.equal(
    baseIsReachable(first, () => {
      throw new Error('bad object')
    }),
    false,
  )
  assert.equal(baseIsReachable(null), false)
})

test('reviewer histories stay separate and round-trip atomically', () => {
  const gitDir = () => '/repo/.git'
  assert.notEqual(
    roundsPath('feat/x', 'codex', gitDir),
    roundsPath('feat/x', 'claude', gitDir),
  )
  assert.notEqual(
    roundsPath('fix/a-b', 'codex', gitDir),
    roundsPath('fix_a-b', 'codex', gitDir),
  )

  const dir = mkdtempSync(join(tmpdir(), 'as-review-rounds-'))
  const path = join(dir, 'branch.json')
  const firstState = recordRound(
    { schema_version: 1, rounds: [] },
    {
      head: first,
      reviewer: 'codex',
      base: defaultBase,
      profile: finalReviews,
    },
  )
  writeRounds(
    path,
    recordRound(firstState, {
      head: second,
      reviewer: 'claude',
      base: defaultBase,
      profile: finalReviews,
    }),
  )
  const read = readRounds(path)
  assert.equal(read.rounds.length, 2)
  assert.deepEqual(
    read.rounds.map(({ reviewer }) => reviewer),
    ['codex', 'claude'],
  )
  assert.deepEqual(read.rounds[1].profile, finalReviews)
})

test('a branch name resolves to a stable private review-round file', () => {
  const path = roundsPath('feat/some thing', 'claude', () => '/repo/.git')
  assert.match(path, /review-rounds\/[0-9a-f]{32}\.json$/u)
})
