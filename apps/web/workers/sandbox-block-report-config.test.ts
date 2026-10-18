import { readFileSync } from 'node:fs'
import { expect, test } from 'vitest'

test('application topologies have independent identical report budgets', () => {
  for (const name of ['wrangler.jsonc', 'wrangler.production.jsonc']) {
    // These configs contain trailing commas, but no comments inside their rate limits.
    const source = readFileSync(new URL(`../${name}`, import.meta.url), 'utf8')
    const block = source.match(/"ratelimits":\s*(\[[\s\S]*?\])/)
    expect(block).not.toBeNull()
    const limits = JSON.parse(block![1]!.replace(/,\s*([}\]])/g, '$1'))
    expect(limits).toEqual(
      expect.arrayContaining([
        {
          name: 'SANDBOX_BLOCK_REPORT_RATELIMIT',
          namespace_id: '1005',
          simple: { limit: 20, period: 60 },
        },
        {
          name: 'MCP_RATELIMIT_USER',
          namespace_id: '1001',
          simple: { limit: 120, period: 60 },
        },
        {
          name: 'MCP_RATELIMIT_WORKSPACE',
          namespace_id: '1002',
          simple: { limit: 60, period: 60 },
        },
        {
          name: 'VIEWER_RATELIMIT',
          namespace_id: '1003',
          simple: { limit: 300, period: 60 },
        },
        {
          name: 'RECIPIENT_SUGGESTIONS_RATELIMIT',
          namespace_id: '1004',
          simple: { limit: 60, period: 60 },
        },
      ]),
    )
    expect(
      new Set(
        limits.map((entry: { namespace_id: string }) => entry.namespace_id),
      ).size,
    ).toBe(5)
    expect(limits).toHaveLength(5)
  }
})
