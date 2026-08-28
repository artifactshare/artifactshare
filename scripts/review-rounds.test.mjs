import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  baseIsReachable,
  rangeIsEmpty,
  readRounds,
  recordRound,
  resolveReviewBase,
  roundsPath,
  writeRounds,
} from './review-rounds.mjs'

const first = 'a'.repeat(40)
const second = 'b'.repeat(40)

test('the first round reads the whole change against its default base', () => {
  assert.deepEqual(
    resolveReviewBase({
      state: { schema_version: 1, rounds: [] },
      reviewer: 'codex',
      defaultBase: 'origin/main',
      head: second,
    }),
    { base: 'origin/main', round: 1, previousHead: null },
  )
})

test('a later round reads only what changed since the last reviewed head', () => {
  const state = recordRound(
    { schema_version: 1, rounds: [] },
    { head: first, reviewer: 'codex' },
  )
  assert.deepEqual(
    resolveReviewBase({
      state,
      reviewer: 'codex',
      defaultBase: 'origin/main',
      head: second,
    }),
    { base: first, round: 2, previousHead: first },
  )
})

test('a reviewer that has not read this branch starts from the default base', () => {
  // Each reviewer has its own file, so an unread branch simply has no rounds.
  assert.equal(
    resolveReviewBase({
      state: { schema_version: 1, rounds: [] },
      reviewer: 'claude',
      defaultBase: 'origin/main',
      head: first,
    }).base,
    'origin/main',
  )
})

test('an empty range is detected for an equal or ancestor head', () => {
  assert.equal(rangeIsEmpty(first, first), true)
  // An ancestor head yields no commits, which reads as clean without looking.
  assert.equal(
    rangeIsEmpty(first, second, () => '0'),
    true,
  )
  assert.equal(
    rangeIsEmpty(first, second, () => '3'),
    false,
  )
  assert.equal(rangeIsEmpty(null, second), false)
})

test('a branch name that differs only by a separator keeps its own rounds', () => {
  const gitDir = () => '/repo/.git'
  assert.notEqual(
    roundsPath('fix/a-b', 'codex', gitDir),
    roundsPath('fix_a-b', 'codex', gitDir),
  )
})

test('each reviewer writes its own file so parallel rounds cannot race', () => {
  const gitDir = () => '/repo/.git'
  assert.notEqual(
    roundsPath('feat/x', 'codex', gitDir),
    roundsPath('feat/x', 'claude', gitDir),
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

test('an explicit base always wins so a full re-read stays available', () => {
  const state = recordRound(
    { schema_version: 1, rounds: [] },
    { head: first, reviewer: 'claude' },
  )
  assert.equal(
    resolveReviewBase({
      state,
      reviewer: 'claude',
      defaultBase: 'origin/main',
      explicitBase: 'origin/main',
      head: first,
    }).base,
    'origin/main',
  )
})

test('rounds round-trip and accumulate per reviewer', () => {
  const dir = mkdtempSync(join(tmpdir(), 'as-review-rounds-'))
  const path = join(dir, 'branch.json')
  writeRounds(
    path,
    recordRound(
      recordRound(readRounds(path), { head: first, reviewer: 'codex' }),
      { head: second, reviewer: 'claude' },
    ),
  )
  const state = readRounds(path)
  assert.equal(state.rounds.length, 2)
  assert.deepEqual(
    state.rounds.map((round) => round.reviewer),
    ['codex', 'claude'],
  )
  assert.equal(
    resolveReviewBase({
      state,
      reviewer: 'claude',
      defaultBase: 'x',
      head: first,
    }).base,
    second,
  )
})

test('a branch name resolves to a stable file under review-rounds', () => {
  const path = roundsPath('feat/some thing', 'claude', () => '/repo/.git')
  assert.match(path, /review-rounds\/[0-9a-f]{32}\.json$/u)
})
