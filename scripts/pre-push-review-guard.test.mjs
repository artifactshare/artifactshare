import assert from 'node:assert/strict'
import test from 'node:test'
import {
  BLOCK_MESSAGE,
  OTHER_BRANCH_MESSAGE,
  STATE_ERROR_MESSAGE,
  checkPrePush,
  shouldCheckPush,
} from './pre-push-review-guard.mjs'

const own = 'refs/heads/feature'
const input = `${own} abc refs/heads/feature def\n`
const run = (value) => ({
  stdin: input,
  branch: 'feature',
  commandExists: () => true,
  runGh: () => value,
})

test('only checks current branch pushes', () => {
  assert.equal(shouldCheckPush(input, 'feature'), true)
  assert.equal(
    shouldCheckPush('refs/tags/v1 a refs/tags/v1 b\n', 'feature'),
    false,
  )
  assert.equal(
    shouldCheckPush('refs/heads/other a refs/heads/other b\n', 'feature'),
    false,
  )
  assert.equal(
    shouldCheckPush('(delete) 0000000 refs/heads/feature\n', 'feature'),
    false,
  )
  assert.equal(
    shouldCheckPush('refs/heads/feature a refs/heads/feature 0\n', 'feature'),
    true,
  )
  assert.equal(shouldCheckPush(input, ''), false)
})

test('blocks draft PR without exact override', () => {
  for (const override of [undefined, '', '0', 'true']) {
    const result = checkPrePush({
      ...run('[{"isDraft":true,"headRefName":"feature"}]'),
      env: { AS_PUSH_AFTER_GO: override },
    })
    assert.equal(result.exitCode, 1)
    assert.match(result.stderr, /local commit/)
    assert.match(result.stderr, /AS_PUSH_AFTER_GO=1 git push/)
  }
})

test('allows override, ready PR, and initial push without a PR', () => {
  assert.equal(
    checkPrePush({
      ...run('[{"isDraft":true,"headRefName":"feature"}]'),
      env: { AS_PUSH_AFTER_GO: '1' },
    }).exitCode,
    0,
  )
  assert.equal(
    checkPrePush(run('[{"isDraft":false,"headRefName":"feature"}]')).exitCode,
    0,
  )
  assert.equal(checkPrePush(run('[]')).exitCode, 0)
})

test('explains when the repository PR belongs to another branch', () => {
  const result = checkPrePush(run('[{"isDraft":true,"headRefName":"other"}]'))
  assert.equal(result.exitCode, 1)
  assert.equal(result.stderr, `${OTHER_BRANCH_MESSAGE}\n`)
})

test('fails closed when PR state cannot be trusted', () => {
  for (const options of [
    { commandExists: () => false },
    {
      runGh: () => {
        throw new Error('offline')
      },
    },
    { runGh: () => 'bad' },
    { runGh: () => '{}' },
    { runGh: () => '[{"isDraft":true},{"isDraft":true}]' },
  ]) {
    const result = checkPrePush({ ...run('[{"isDraft":true}]'), ...options })
    assert.equal(result.exitCode, 1)
    assert.equal(result.stderr, `${STATE_ERROR_MESSAGE}\n`)
  }
})

test('ignores non-current refs without invoking gh', () => {
  let called = false
  const result = checkPrePush({
    stdin: 'refs/tags/v1 a refs/tags/v1 b\n',
    branch: 'feature',
    commandExists: () => {
      called = true
      return true
    },
    runGh: () => '{}',
  })
  assert.equal(result.exitCode, 0)
  assert.equal(called, false)
})

test('exports stable refusal message', () =>
  assert.match(BLOCK_MESSAGE, /Draft PR/))
