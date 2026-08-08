import assert from 'node:assert/strict'
import test from 'node:test'
import { verifyValidatedSha } from './verify-validated-sha.mjs'

const sha = 'a'.repeat(40)
const validRun = {
  id: 42,
  run_attempt: 1,
  path: '.github/workflows/public-ci.yml',
  event: 'merge_group',
  head_sha: sha,
  status: 'completed',
  conclusion: 'success',
}

function response(workflowRuns, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => ({ workflow_runs: workflowRuns }),
  }
}

test('accepts only the trusted merge-group workflow for the exact SHA', async () => {
  let requestedUrl
  const result = await verifyValidatedSha({
    repository: 'artifactshare/artifactshare',
    sha,
    token: 'test-token',
    fetchImpl: (url) => {
      requestedUrl = url
      return response([validRun])
    },
  })
  assert.equal(result.runId, 42)
  assert.equal(requestedUrl.searchParams.get('event'), 'merge_group')
  assert.equal(requestedUrl.searchParams.get('head_sha'), sha)
  assert.match(requestedUrl.pathname, /workflows\/public-ci\.yml\/runs$/u)
})

for (const [name, run] of [
  ['missing run', null],
  ['failed run', { ...validRun, conclusion: 'failure' }],
  ['wrong event', { ...validRun, event: 'push' }],
  ['wrong SHA', { ...validRun, head_sha: 'b'.repeat(40) }],
  ['wrong workflow', { ...validRun, path: '.github/workflows/other.yml' }],
])
  test(`rejects ${name}`, async () => {
    await assert.rejects(
      verifyValidatedSha({
        repository: 'artifactshare/artifactshare',
        sha,
        token: 'test-token',
        fetchImpl: () => response(run ? [run] : []),
      }),
      /No successful merge-group validation/u,
    )
  })

test('rejects API failures and malformed inputs', async () => {
  await assert.rejects(
    verifyValidatedSha({
      repository: 'artifactshare/artifactshare',
      sha,
      token: 'test-token',
      fetchImpl: () => response([], 403),
    }),
    /request failed: 403/u,
  )
  await assert.rejects(
    verifyValidatedSha({
      repository: 'invalid',
      sha,
      token: 'test-token',
    }),
  )
})
