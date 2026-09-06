import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  ANTHROPIC_LINK_ABUSE_MODEL,
  ANTHROPIC_LINK_ABUSE_TOOL_NAME,
  judgmentUserPrompt,
  LINK_ABUSE_SYSTEM_PROMPT,
  linkAbuseJudgmentJsonSchema,
  parseLinkAbuseJudgment,
  WORKERS_AI_LINK_ABUSE_MODEL,
} from '../apps/web/app/services/link-abuse-judgment/contract.ts'
import {
  LINK_ABUSE_EXTERNAL_DOMAIN_LIMIT,
  LINK_ABUSE_TEXT_LIMIT,
  extractLinkAbuseContent,
} from '../apps/web/app/services/link-abuse-judgment/extract.ts'

const provider = providerArg(process.argv.slice(2))
const fixtureRoot = fileURLToPath(
  new URL('../apps/web/fixtures/link-abuse-judgment/', import.meta.url),
)
const names = (await readdir(fixtureRoot, { withFileTypes: true }))
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort()
const rows = []
const mismatches = []

for (const name of names) {
  const directory = join(fixtureRoot, name)
  const [html, expectedRaw] = await Promise.all([
    readFile(join(directory, 'index.html'), 'utf8'),
    readFile(join(directory, 'expected.json'), 'utf8'),
  ])
  const expected = validateExpected(JSON.parse(expectedRaw), name)
  const extracted = extractLinkAbuseContent(html)
  if (extracted.text.length === 0)
    throw new Error(`${name}: extracted text is empty`)
  if (extracted.text.length > LINK_ABUSE_TEXT_LIMIT)
    throw new Error(`${name}: extracted text exceeded the cap`)
  if (extracted.externalDomains.length > LINK_ABUSE_EXTERNAL_DOMAIN_LIMIT)
    throw new Error(`${name}: extracted domains exceeded the cap`)

  const input = {
    text: extracted.text,
    externalDomains: extracted.externalDomains,
    accountAgeDays: 30,
    workspacePlan: 'plus',
    trigger: 'manual',
    detail: 'evaluation_fixture',
  }
  const actual = await runIfConfigured(provider, input)
  if (
    actual &&
    (actual.risk !== expected.risk ||
      actual.impersonatedBrand !== expected.impersonatedBrand)
  ) {
    mismatches.push(
      `${name}: expected risk=${expected.risk}, brand=${expected.impersonatedBrand ?? '(none)'}; received risk=${actual.risk}, brand=${actual.impersonatedBrand ?? '(none)'}`,
    )
  }
  rows.push({
    fixture: name,
    expectedRisk: expected.risk,
    actualRisk: actual?.risk ?? '(offline)',
    expectedBrand: expected.impersonatedBrand ?? '(none)',
    actualBrand: actual?.impersonatedBrand ?? (actual ? '(none)' : '(offline)'),
    extractedDomains: extracted.externalDomains.join(', ') || '(none)',
  })
}

console.table(rows)
for (const mismatch of mismatches) console.error(`Mismatch: ${mismatch}`)
console.log(
  rows.some((row) => row.actualRisk === '(offline)')
    ? `Validated ${rows.length} fixtures and extraction; ${provider} credentials were not present, so no live model ran.`
    : `Ran ${rows.length} ${provider} judgments.`,
)
if (mismatches.length > 0) process.exitCode = 1

function providerArg(args) {
  const index = args.indexOf('--provider')
  const value = index >= 0 ? args[index + 1] : 'workers-ai'
  if (value !== 'workers-ai' && value !== 'anthropic') {
    throw new Error('--provider must be workers-ai or anthropic')
  }
  return value
}

function validateExpected(value, name) {
  if (
    !value ||
    typeof value !== 'object' ||
    !['low', 'medium', 'high'].includes(value.risk) ||
    !('impersonatedBrand' in value) ||
    (value.impersonatedBrand !== null &&
      typeof value.impersonatedBrand !== 'string')
  ) {
    throw new Error(`${name}: invalid expected.json`)
  }
  return value
}

async function runIfConfigured(selectedProvider, input) {
  if (selectedProvider === 'workers-ai') {
    const token = process.env.CLOUDFLARE_API_TOKEN
    const accountId = process.env.CLOUDFLARE_ACCOUNT_ID
    if (!token || !accountId) return null
    const response = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${WORKERS_AI_LINK_ABUSE_MODEL}`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          messages: [
            { role: 'system', content: LINK_ABUSE_SYSTEM_PROMPT },
            { role: 'user', content: judgmentUserPrompt(input) },
          ],
          max_tokens: 700,
          temperature: 0,
          response_format: {
            type: 'json_schema',
            json_schema: linkAbuseJudgmentJsonSchema,
          },
        }),
      },
    )
    if (!response.ok)
      throw new Error(`Workers AI returned HTTP ${response.status}`)
    const body = await response.json()
    if (!body.success)
      throw new Error('Workers AI returned an unsuccessful result')
    return parseLinkAbuseJudgment(
      body.result?.response ?? body.result,
      input.externalDomains,
    )
  }

  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) return null
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'anthropic-version': '2023-06-01',
      'x-api-key': apiKey,
    },
    body: JSON.stringify({
      model: ANTHROPIC_LINK_ABUSE_MODEL,
      max_tokens: 700,
      system: LINK_ABUSE_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: judgmentUserPrompt(input) }],
      tools: [
        {
          name: ANTHROPIC_LINK_ABUSE_TOOL_NAME,
          description: 'Record the link abuse risk judgment.',
          input_schema: linkAbuseJudgmentJsonSchema,
        },
      ],
      tool_choice: { type: 'tool', name: ANTHROPIC_LINK_ABUSE_TOOL_NAME },
    }),
  })
  if (!response.ok)
    throw new Error(`Anthropic returned HTTP ${response.status}`)
  const body = await response.json()
  const toolUse = body.content?.find(
    (part) =>
      part.type === 'tool_use' && part.name === ANTHROPIC_LINK_ABUSE_TOOL_NAME,
  )
  return parseLinkAbuseJudgment(toolUse?.input, input.externalDomains)
}
