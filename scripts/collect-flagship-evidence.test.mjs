import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import YAML from 'yaml'
import { collectFlagshipEvidence } from './collect-flagship-evidence.mjs'

const SHA = 'a'.repeat(40)
const workflowText = fs.readFileSync(
  '.github/workflows/flagship-access-resolve-evidence.yml',
  'utf8',
)
const workflow = YAML.parse(workflowText)

function environment(overrides = {}) {
  return {
    EXPECTED_SHA: SHA,
    GITHUB_SHA: SHA,
    EXPECTED_TARGET_COUNT: '2',
    CLOUDFLARE_ACCOUNT_ID: 'account-test',
    FLAGSHIP_APP_ID: 'app-test',
    FLAGSHIP_EVALUATE_TOKEN: 'token-test',
    FLAGSHIP_TARGETING_KEYS_JSON: '["workspace-one","workspace-two"]',
    FLAGSHIP_EVIDENCE_HMAC_KEY: 'evidence-key-test',
    ...overrides,
  }
}

test('collects redacted, integrity-bound shadow evaluations', async () => {
  const seen = []
  const evidence = await collectFlagshipEvidence({
    env: environment(),
    now: () => new Date('2026-09-16T00:00:00.000Z'),
    fetchImpl: (url, init) => {
      seen.push({ url: String(url), authorization: init.headers.Authorization })
      return Response.json({
        flagKey: 'access-resolve',
        value: 'shadow',
        variant: 'shadow',
        reason: 'TARGETING_MATCH',
      })
    },
  })

  assert.equal(evidence.targetCount, 2)
  assert.equal(evidence.sourceSha, SHA)
  assert.equal(evidence.integrity.algorithm, 'hmac-sha256')
  assert.match(evidence.integrity.digest, /^[0-9a-f]{64}$/u)
  const serialized = JSON.stringify(evidence)
  assert.doesNotMatch(serialized, /workspace-one|workspace-two|token-test/u)
  assert.equal(seen.length, 2)
  assert.match(seen[0].url, /flagKey=access-resolve/u)
  assert.match(seen[0].url, /targetingKey=workspace-one/u)
  assert.equal(seen[0].authorization, 'Bearer token-test')
})

test('fails closed for invalid inputs without printing protected values', async () => {
  await assert.rejects(
    collectFlagshipEvidence({
      env: environment({ EXPECTED_TARGET_COUNT: '3' }),
      fetchImpl: () => {
        throw new Error('must not run')
      },
    }),
    /match EXPECTED_TARGET_COUNT/u,
  )
  await assert.rejects(
    collectFlagshipEvidence({
      env: environment(),
      fetchImpl: () => new Response('secret response', { status: 403 }),
    }),
    (error) => {
      assert.match(error.message, /target 1 with HTTP 403/u)
      assert.doesNotMatch(error.message, /secret response|workspace-one/u)
      return true
    },
  )
})

test('rejects malformed or non-shadow Flagship responses', async () => {
  for (const response of [
    new Response('not-json'),
    Response.json({
      flagKey: 'access-resolve',
      value: 'off',
      variant: 'off',
      reason: 'DEFAULT',
    }),
    Response.json({
      flagKey: 'other',
      value: 'shadow',
      variant: 'shadow',
      reason: 'TARGETING_MATCH',
    }),
  ]) {
    await assert.rejects(
      collectFlagshipEvidence({
        env: environment(),
        fetchImpl: () => response.clone(),
      }),
      /invalid JSON|unexpected contract/u,
    )
  }
})

test('workflow is manual, protected, read-only, and pinned', () => {
  assert.deepEqual(YAML.parseDocument(workflowText).errors, [])
  assert.deepEqual(Object.keys(workflow.on), ['workflow_dispatch'])
  assert.deepEqual(workflow.permissions, { actions: 'read', contents: 'read' })
  assert.deepEqual(workflow.jobs.evaluate.environment, { name: 'production' })
  assert.match(workflowText, /FLAGSHIP_EVALUATE_TOKEN/u)
  assert.match(workflowText, /FLAGSHIP_TARGETING_KEYS_JSON/u)
  assert.match(workflowText, /actions\/checkout@[0-9a-f]{40}/u)
  assert.match(workflowText, /actions\/setup-node@[0-9a-f]{40}/u)
  assert.match(workflowText, /actions\/upload-artifact@[0-9a-f]{40}/u)
  assert.doesNotMatch(
    workflowText,
    /wrangler|workflow_dispatch:.*workflow|curl|cloudflare.*(?:put|post|patch|delete)/iu,
  )
})
