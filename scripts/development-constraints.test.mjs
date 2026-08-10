import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const docPath = 'docs/reference/development-constraints.md'
const doc = fs.readFileSync(path.join(root, docPath), 'utf8')
const domains = {
  Analytics: ['計測への影響', 'apps/web/app/lib/analytics/events.ts'],
  依存管理: ['minimumReleaseAgeExclude', 'pnpm-workspace.yaml'],
  'D1 と SQLite': ['constraint error', 'apps/web/db/schema.sql'],
  'React Router と Web UI': [
    '負の対照',
    'apps/web/app/routes/auth-middleware-contract.test.ts',
  ],
  Workers: ['anchorServerBuild', 'apps/web/workers/app.test.ts'],
  i18n: ['literal backtick', 'apps/web/app/i18n/messages.ts'],
  Legal: ['billing.*', 'apps/web/app/services/legal-content.server.ts'],
  Updates: [
    'language pair',
    'apps/web/app/services/updates-content.server.test.ts',
  ],
  CLI: ['Gunshi', 'apps/web/app/lib/cli-capability-matrix.json'],
}
const pathPattern =
  /`((?:[^`\s]+\/)+[^`\s]*|pnpm-workspace\.yaml|package\.json)`/u
const pathPatternGlobal = new RegExp(pathPattern.source, 'gu')

function sectionFor(content, domain) {
  return content.split(/^## /mu).find((part) => part.startsWith(domain))
}

function assertContract(content = doc, rootPath = root) {
  for (const [domain, phrases] of Object.entries(domains)) {
    const section = sectionFor(content, domain)
    assert.ok(section, domain)
    for (const label of [
      '機械検査で強制済み',
      '人が判断する現行規則',
      '復元しない事項',
    ])
      assert.ok(section.includes(`**${label}**`), `${domain}: ${label}`)
    assert.match(
      section,
      /現行実装に該当がない|機械検査へ置き換わった|公開範囲外/u,
    )
    for (const phrase of phrases)
      assert.ok(section.includes(phrase), `${domain}: ${phrase}`)
    assert.match(section, pathPattern)
  }
  for (const [, reference] of content.matchAll(pathPatternGlobal))
    assert.ok(fs.existsSync(path.join(rootPath, reference)), reference)
}

function assertEntrances(
  agents = fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8'),
  claude = fs.readFileSync(path.join(root, 'CLAUDE.md'), 'utf8'),
) {
  for (const content of [agents, claude])
    assert.match(content, /`docs\/reference\/development-constraints\.md`/u)
}

test('root agents reach the same development constraints reference', () =>
  assertEntrances())

test('development constraints cover every domain, classification, invariant, and live path', () =>
  assertContract())

test('stale and non-public references are absent', () => {
  assert.doesNotMatch(
    doc,
    /\bprivate\b|internal spec|\.claude\/rules|https?:\/\/|issue\b/iu,
  )
})

test('negative control: removing an entrance link fails', () =>
  assert.throws(() => assertEntrances('', '')))

test('negative control: a missing referenced path fails', () => {
  assert.throws(
    () =>
      assertContract(
        doc.replace(
          'scripts/check-analytics-literals.mjs',
          'scripts/missing-analytics.mjs',
        ),
      ),
    /scripts\/missing-analytics\.mjs/,
  )
})
