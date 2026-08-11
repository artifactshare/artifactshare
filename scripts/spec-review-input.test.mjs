import assert from 'node:assert/strict'
import test from 'node:test'
import { cliPackage, specReviewPrompt } from './spec-review-input.mjs'

function envelope(overrides = {}) {
  return JSON.stringify({
    ok: true,
    data: {
      content: 'Final requirement',
      version_id: 'v1',
      truncated: false,
      comments_has_more: false,
      comments: [
        { status: 'resolved', id: 'old', messages: [] },
        {
          status: 'open',
          id: 'open',
          anchor: 'requirement',
          messages: [
            {
              message_id: 'm1',
              body: 'Check this edge',
              created_at: '2026-08-11T00:00:00Z',
              ignored: 'private transport detail',
            },
          ],
        },
      ],
      ...overrides,
    },
  })
}

test('builds one bounded prompt for both spec reviewers', () => {
  let invocation
  const prompt = specReviewPrompt({
    artifactUrl: 'https://example.test/a/spec',
    versionId: 'v1',
    run: (file, args) => {
      invocation = [file, args]
      return envelope()
    },
  })
  assert.equal(invocation[0], 'npm')
  assert.ok(invocation[1].includes(`--package=${cliPackage}`))
  assert.ok(invocation[1].includes('https://example.test/a/spec'))
  assert.match(prompt, /Artifact Share version: v1/u)
  assert.match(prompt, /Final requirement/u)
  assert.match(prompt, /Check this edge/u)
  assert.doesNotMatch(prompt, /private transport detail|"old"/u)
})

test('rejects stale or incomplete spec input', () => {
  const options = {
    artifactUrl: 'https://example.test/a/spec',
    versionId: 'v1',
  }
  assert.throws(
    () =>
      specReviewPrompt({
        ...options,
        run: () => envelope({ version_id: 'v2' }),
      }),
    /version does not match/u,
  )
  assert.throws(
    () =>
      specReviewPrompt({
        ...options,
        run: () => envelope({ truncated: true }),
      }),
    /incomplete/u,
  )
})
