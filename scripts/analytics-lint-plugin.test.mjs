import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import plugin from './analytics-lint-plugin.mjs'

const root = resolve(import.meta.dirname, '..')
const memberEvents = [
  `window.gtag('event', 'page_view')`,
  `window['gtag']('event', 'page_view')`,
  `window["gtag"]?.('event', 'page_view')`,
  `window['dataLayer'].push({ event: 'page_view' })`,
  `window.dataLayer?.push({ event: 'page_view' })`,
  `window?.["dataLayer"]?.['push']({ event: 'page_view' })`,
]
const allowedCommands = [
  `window.gtag('consent', 'update', {})`,
  `window['gtag']('consent', 'update', {})`,
  `window["gtag"]?.('config', 'G-example')`,
  `window?.gtag?.('consent', 'update', {})`,
]
function violations(file, text) {
  const reports = []
  const visitor = plugin.rules['typed-sender'].create({
    filename: join(root, file),
    sourceCode: {
      text,
      getLocFromIndex: (index) => ({ line: 1, column: index }),
    },
    report: (report) => reports.push(report),
  })
  visitor.Program?.()
  return reports
}

test('rejects direct events and dataLayer sends including receivers and embedded snippets', () => {
  for (const text of [
    ...memberEvents,
    `gtag('event', 'page_view')`,
    `window.gtag('event', 'page_view')`,
    `globalThis.gtag('event', 'page_view')`,
    `const w = window; w.gtag('event', 'page_view')`,
    `w.gtag?.('event', 'page_view')`,
    `window.gtag( 'event', 'page_view')`,
    `dataLayer.push({ event: 'page_view' })`,
    `window.dataLayer.push({ event: 'page_view' })`,
    `globalThis.dataLayer.push({ event: 'page_view' })`,
    `const w = window; w.dataLayer.push({ event: 'page_view' })`,
    '// dataLayer.push is also scanned',
    "const snippet = \"gtag('event', 'page_view')\"",
  ]) {
    assert.equal(
      violations('apps/web/app/routes/example.tsx', text).length,
      1,
      text,
    )
  }
})

test('preserves app TS/TSX scan scope, exact allowlist, and test exclusions', () => {
  for (const file of [
    'apps/web/app/root.tsx',
    'apps/web/app/lib/analytics/track.client.ts',
    'apps/web/app/routes/example.test.ts',
    'apps/web/app/routes/example.test.tsx',
    'apps/web/app/routes/example.js',
    'scripts/example.ts',
  ])
    assert.equal(violations(file, `gtag('event', 'x')`).length, 0, file)
  for (const file of [
    'apps/web/app/components/ui/example.tsx',
    'apps/web/app/routes/example.spec.ts',
    'apps/web/app/routes/example.ts',
  ])
    assert.equal(violations(file, `gtag('event', 'x')`).length, 1, file)
  assert.equal(
    violations(
      'apps/web/app/routes/example.ts',
      `w.gtag('consent', 'update', {}); w.gtag('config', 'G-example')`,
    ).length,
    0,
  )
  for (const text of allowedCommands)
    assert.equal(
      violations('apps/web/app/routes/example.ts', text).length,
      0,
      text,
    )
})

test('supported lint configuration executes the rule for member access', () => {
  const directory = mkdtempSync(
    join(root, 'apps/web/app/analytics-lint-fixture-'),
  )
  try {
    const file = join(directory, 'example.ts')
    for (const text of memberEvents) {
      writeFileSync(file, `${text}\n`)
      const result = spawnSync(
        'pnpm',
        ['exec', 'vp', 'lint', '-c', '.oxlintrc.json', file],
        { cwd: root, encoding: 'utf8' },
      )
      assert.equal(result.status, 1, text + result.stdout + result.stderr)
      assert.match(
        result.stdout + result.stderr,
        /analytics\(typed-sender\)|analytics\/typed-sender/,
        text,
      )
    }
    writeFileSync(file, allowedCommands.join('\n') + '\n')
    const valid = spawnSync(
      'pnpm',
      ['exec', 'vp', 'lint', '-c', '.oxlintrc.json', file],
      { cwd: root, encoding: 'utf8' },
    )
    assert.equal(valid.status, 0, valid.stdout + valid.stderr)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
