import assert from 'node:assert/strict'
import test from 'node:test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { finalReviews } from './agent-role-settings.mjs'
import {
  baseIsReachable,
  isStrictAncestor,
  matchingPairHistory,
  pairCoversBranch,
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
      commitBase: third,
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
  assert.equal(read.rounds[1].commitBase, third)
  assert.equal(read.rounds[0].commitBase, undefined)
})

test('a branch name resolves to a stable private review-round file', () => {
  const path = roundsPath('feat/some thing', 'claude', () => '/repo/.git')
  assert.match(path, /review-rounds\/[0-9a-f]{32}\.json$/u)
})

test('original message base propagates only from agreeing reused pairs', () => {
  for (const [codexBase, claudeBase] of [
    [third, third],
    [third, undefined],
    [third, second],
    [undefined, undefined],
  ]) {
    const history = pair(first)
    history.codexState.rounds[0].commitBase = codexBase
    history.claudeState.rounds[0].commitBase = claudeBase
    for (const head of [first, second]) {
      const result = resolvePairReviewBase({
        ...history,
        profile: finalReviews,
        defaultBase,
        head,
        run: () => '1',
      })
      assert.equal(result.base, head === first ? defaultBase : first)
      assert.equal(
        result.commitBase,
        codexBase === claudeBase ? codexBase : undefined,
      )
    }
    const divergent = resolvePairReviewBase({
      ...history,
      profile: finalReviews,
      defaultBase,
      head: second,
      run: () => {
        throw new Error('divergent')
      },
    })
    assert.equal(divergent.commitBase, undefined)
  }
})

test('a pair covers the branch only from the merge base or through earlier pairs', (t) => {
  const repo = mkdtempSync(join(tmpdir(), 'review-range-'))
  t.after(() => rmSync(repo, { recursive: true, force: true }))
  const run = (file, args) =>
    execFileSync(file, args, { cwd: repo, encoding: 'utf8' }).trim()
  const git = (...args) => run('git', args)
  git('init', '--quiet', '-b', 'main')
  git('config', 'user.name', 'Test')
  git('config', 'user.email', 'test@example.test')
  git('commit', '--quiet', '--allow-empty', '-m', 'base')
  const mergeBase = git('rev-parse', 'HEAD')
  git('switch', '--quiet', '-c', 'topic')
  const commits = []
  for (let index = 1; index <= 10; index += 1) {
    git('commit', '--quiet', '--allow-empty', '-m', `change ${index}`)
    commits.push(git('rev-parse', 'HEAD'))
  }
  const head = commits.at(-1)
  const parent = commits.at(-2)
  const rounds = (pairs) => {
    const of = (reviewer) => ({
      schema_version: 1,
      rounds: pairs.map(([pairHead, base]) => ({
        head: pairHead,
        reviewer,
        base,
        profile: finalReviews,
      })),
    })
    return { codexState: of('codex'), claudeState: of('claude') }
  }
  const covers = (history, base) =>
    pairCoversBranch({
      ...history,
      profile: finalReviews,
      pair: { head, base },
      mergeBase,
      run,
    })

  // A default pair reads origin/main...HEAD, which starts at the merge base.
  assert.equal(covers(rounds([[head, mergeBase]]), mergeBase), true)
  // `--base HEAD~1` leaves nine of the ten commits unreviewed.
  assert.equal(covers(rounds([[head, parent]]), parent), false)
  // Narrowed from an earlier pair on HEAD~1 that reviewed from the merge base.
  const chained = [
    [parent, mergeBase],
    [head, parent],
  ]
  assert.equal(covers(rounds(chained), parent), true)
  // An earlier pair that was itself narrow does not extend the chain.
  const narrowEarlier = [
    [parent, commits[0]],
    [head, parent],
  ]
  assert.equal(covers(rounds(narrowEarlier), parent), false)
  // A single reviewer's earlier round is not a completed pair.
  const partial = rounds(chained)
  partial.codexState.rounds.shift()
  assert.equal(covers(partial, parent), false)
  // A later narrow rerun on HEAD~1 does not hide the earlier full pair there.
  const rerun = [
    [parent, mergeBase],
    [parent, commits.at(-3)],
    [head, parent],
  ]
  assert.equal(covers(rounds(rerun), parent), true)

  // Merging main after the pair on HEAD moves the merge base; the commits it
  // brings in are not branch work, so the old chain still reaches it.
  git('switch', '--quiet', 'main')
  git('commit', '--quiet', '--allow-empty', '-m', 'main moves')
  const newMergeBase = git('rev-parse', 'HEAD')
  git('switch', '--quiet', 'topic')
  git('merge', '--quiet', '--no-ff', '-m', 'merge main', 'main')
  const merged = git('rev-parse', 'HEAD')
  assert.equal(
    pairCoversBranch({
      ...rounds([
        [head, mergeBase],
        [merged, head],
      ]),
      profile: finalReviews,
      pair: { head: merged, base: head },
      mergeBase: newMergeBase,
      run,
    }),
    true,
  )
})
