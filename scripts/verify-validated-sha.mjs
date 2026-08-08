import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'

const trustedWorkflow = 'public-ci.yml'
const trustedWorkflowPath = '.github/workflows/public-ci.yml'

export async function verifyValidatedSha({
  repository,
  sha,
  token,
  fetchImpl = fetch,
}) {
  assert.match(repository, /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u)
  assert.match(sha, /^[0-9a-f]{40}$/u)
  assert.ok(token, 'GITHUB_TOKEN is required')

  const endpoint = new URL(
    `https://api.github.com/repos/${repository}/actions/workflows/${trustedWorkflow}/runs`,
  )
  endpoint.search = new URLSearchParams({
    event: 'merge_group',
    head_sha: sha,
    status: 'completed',
    per_page: '100',
  }).toString()
  const response = await fetchImpl(endpoint, {
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${token}`,
      'x-github-api-version': '2022-11-28',
    },
  })
  if (!response.ok)
    throw new Error(`GitHub workflow runs request failed: ${response.status}`)
  const payload = await response.json()
  const trustedRun = payload.workflow_runs?.find(
    (run) =>
      run.path === trustedWorkflowPath &&
      run.event === 'merge_group' &&
      run.head_sha === sha &&
      run.status === 'completed' &&
      run.conclusion === 'success',
  )
  if (!trustedRun)
    throw new Error(`No successful merge-group validation for ${sha}`)
  return {
    runId: trustedRun.id,
    runAttempt: trustedRun.run_attempt,
    sha,
    workflowPath: trustedWorkflowPath,
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const result = await verifyValidatedSha({
    repository: process.env.GITHUB_REPOSITORY ?? '',
    sha: process.argv[2] ?? process.env.GITHUB_SHA ?? '',
    token: process.env.GITHUB_TOKEN ?? '',
  })
  process.stdout.write(`${JSON.stringify(result)}\n`)
}
