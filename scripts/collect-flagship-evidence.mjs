import { createHmac } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'

const FLAG_KEY = 'access-resolve'
const ALLOWED_REASONS = new Set([
  'TARGETING_MATCH',
  'DEFAULT',
  'DISABLED',
  'SPLIT',
])

function required(env, name) {
  const value = env[name]?.trim()
  if (!value) throw new Error(`Missing required ${name}`)
  return value
}

function parseInputs(env) {
  const expectedSha = required(env, 'EXPECTED_SHA')
  const sourceSha = required(env, 'GITHUB_SHA')
  if (!/^[0-9a-f]{40}$/u.test(expectedSha) || expectedSha !== sourceSha) {
    throw new Error('EXPECTED_SHA must match the checked-out 40-character SHA')
  }
  const expectedTargetCount = Number(required(env, 'EXPECTED_TARGET_COUNT'))
  if (!Number.isSafeInteger(expectedTargetCount) || expectedTargetCount < 1) {
    throw new Error('EXPECTED_TARGET_COUNT must be a positive integer')
  }
  let targets
  try {
    targets = JSON.parse(required(env, 'FLAGSHIP_TARGETING_KEYS_JSON'))
  } catch {
    throw new Error('FLAGSHIP_TARGETING_KEYS_JSON must be a JSON array')
  }
  if (
    !Array.isArray(targets) ||
    targets.some(
      (target) =>
        typeof target !== 'string' || target.trim() !== target || !target,
    ) ||
    new Set(targets).size !== targets.length ||
    targets.length !== expectedTargetCount
  ) {
    throw new Error(
      'Protected targeting keys must be non-empty, unique, and match EXPECTED_TARGET_COUNT',
    )
  }
  return {
    expectedSha,
    targets,
    accountId: required(env, 'CLOUDFLARE_ACCOUNT_ID'),
    appId: required(env, 'FLAGSHIP_APP_ID'),
    token: required(env, 'FLAGSHIP_EVALUATE_TOKEN'),
    hmacKey: required(env, 'FLAGSHIP_EVIDENCE_HMAC_KEY'),
  }
}

export async function collectFlagshipEvidence({
  env,
  fetchImpl = fetch,
  now = () => new Date(),
}) {
  const input = parseInputs(env)
  const evaluations = []
  for (const [index, target] of input.targets.entries()) {
    const url = new URL(
      `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(input.accountId)}/flagship/apps/${encodeURIComponent(input.appId)}/evaluate`,
    )
    url.searchParams.set('flagKey', FLAG_KEY)
    url.searchParams.set('targetingKey', target)
    url.searchParams.set('workspaceId', target)
    let response
    try {
      response = await fetchImpl(url, {
        headers: { Authorization: `Bearer ${input.token}` },
      })
    } catch {
      throw new Error(
        `Flagship evaluation request failed for target ${index + 1}`,
      )
    }
    if (!response.ok) {
      throw new Error(
        `Flagship evaluation failed for target ${index + 1} with HTTP ${response.status}`,
      )
    }
    let body
    try {
      body = await response.json()
    } catch {
      throw new Error(
        `Flagship evaluation returned invalid JSON for target ${index + 1}`,
      )
    }
    if (
      body?.flagKey !== FLAG_KEY ||
      body?.value !== 'shadow' ||
      body?.variant !== 'shadow' ||
      !ALLOWED_REASONS.has(body?.reason)
    ) {
      throw new Error(
        `Flagship evaluation returned an unexpected contract for target ${index + 1}`,
      )
    }
    evaluations.push({
      targetDigest: createHmac('sha256', input.hmacKey)
        .update(target)
        .digest('hex'),
      mode: body.value,
      variant: body.variant,
      reason: body.reason,
    })
  }
  evaluations.sort((left, right) =>
    left.targetDigest.localeCompare(right.targetDigest),
  )
  const evidence = {
    schemaVersion: 1,
    generatedAt: now().toISOString(),
    sourceSha: input.expectedSha,
    flagKey: FLAG_KEY,
    expectedMode: 'shadow',
    targetCount: evaluations.length,
    evaluations,
  }
  const canonical = JSON.stringify(evidence)
  return {
    ...evidence,
    integrity: {
      algorithm: 'hmac-sha256',
      digest: createHmac('sha256', input.hmacKey)
        .update(canonical)
        .digest('hex'),
    },
  }
}

async function main() {
  const outputPath = required(process.env, 'OUTPUT_PATH')
  const evidence = await collectFlagshipEvidence({ env: process.env })
  await writeFile(outputPath, `${JSON.stringify(evidence, null, 2)}\n`, {
    mode: 0o600,
  })
  process.stdout.write(
    `Validated ${evidence.targetCount} protected Flagship targets in shadow mode.\n`,
  )
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : 'Evidence collection failed'}\n`,
    )
    process.exitCode = 1
  })
}
