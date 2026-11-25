import { readFileSync } from 'node:fs'
import { expect, test } from 'vitest'

type RateLimit = {
  name: string
  namespace_id: string
  simple: { limit: number; period: number }
}

function readRateLimits(config: string): RateLimit[] {
  // These configs contain trailing commas, but no comments inside their rate limits.
  const source = readFileSync(new URL(`../${config}`, import.meta.url), 'utf8')
  const block = source.match(/"ratelimits":\s*(\[[\s\S]*?\])/)
  expect(block, config).not.toBeNull()
  return JSON.parse(block![1]!.replace(/,\s*([}\]])/g, '$1'))
}

const byName = (limits: RateLimit[]) =>
  [...limits].sort((one, other) => one.name.localeCompare(other.name))

test('application topologies have independent identical report budgets', () => {
  const development = readRateLimits('wrangler.jsonc')
  const production = readRateLimits('wrangler.production.jsonc')
  expect(byName(production)).toEqual(byName(development))

  for (const limits of [development, production]) {
    expect(limits.map((limit) => limit.name)).toContain(
      'SANDBOX_BLOCK_REPORT_RATELIMIT',
    )
    expect(new Set(limits.map((limit) => limit.namespace_id)).size).toBe(
      limits.length,
    )
    for (const limit of limits) {
      expect(limit.simple.limit, limit.name).toBeGreaterThan(0)
      expect(limit.simple.period, limit.name).toBeGreaterThan(0)
    }
  }
})
