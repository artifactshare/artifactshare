import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { findAnalyticsLiteralViolations } from './check-analytics-literals.mjs'
test('reports forbidden GA4 literals', () => {
  const root = mkdtempSync(join(tmpdir(), 'analytics-literals-'))
  mkdirSync(join(root, 'apps/web/app'), { recursive: true })
  writeFileSync(
    join(root, 'apps/web/app/example.ts'),
    "gtag('event', 'x')\ndataLayer.push(x)\n",
  )
  assert.equal(findAnalyticsLiteralViolations(root).length, 2)
})
test('accepts clean input and allowlisted sender', () => {
  const root = mkdtempSync(join(tmpdir(), 'analytics-literals-'))
  mkdirSync(join(root, 'apps/web/app/lib/analytics'), { recursive: true })
  writeFileSync(join(root, 'apps/web/app/example.ts'), 'const value = 1\n')
  writeFileSync(
    join(root, 'apps/web/app/lib/analytics/track.client.ts'),
    "gtag('event', 'x')\n",
  )
  assert.deepEqual(findAnalyticsLiteralViolations(root), [])
})
test('current repository has no violations', () =>
  assert.deepEqual(findAnalyticsLiteralViolations(), []))
