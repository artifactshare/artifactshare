import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import plugin from './analytics-lint-plugin.mjs'

const root = resolve(import.meta.dirname, '..')

// Lint every case in one process: each case gets its own directory so the
// file names stay as written, and the JSON report is split back per file.
function lintCases(directory, config, cases) {
  const files = cases.map(({ text, name }, index) => {
    const file = join(directory, `case-${index}`, name)
    mkdirSync(join(directory, `case-${index}`), { recursive: true })
    writeFileSync(file, `${text}\n`)
    return file
  })
  const result = spawnSync(
    'pnpm',
    ['exec', 'vp', 'lint', '-c', config, '-f', 'json', ...files],
    { cwd: root, encoding: 'utf8' },
  )
  const output = result.stdout + result.stderr
  assert.ok([0, 1].includes(result.status), output)
  const report = JSON.parse(result.stdout.slice(result.stdout.indexOf('{')))
  assert.equal(report.number_of_files, files.length, output)
  return files.map((file) => {
    const errors = report.diagnostics.filter(
      (diagnostic) =>
        diagnostic.filename === relative(root, file) &&
        diagnostic.severity === 'error',
    )
    return {
      errors,
      typedSender: errors.some((diagnostic) =>
        /analytics\(typed-sender\)|analytics\/typed-sender/.test(
          diagnostic.code,
        ),
      ),
      output: JSON.stringify(errors),
    }
  })
}
const memberEvents = [
  `window.gtag('event', 'page_view')`,
  `window['gtag']('event', 'page_view')`,
  `window["gtag"]?.('event', 'page_view')`,
  `window['dataLayer'].push({ event: 'page_view' })`,
  `window.dataLayer?.push({ event: 'page_view' })`,
  `window?.["dataLayer"]?.['push']({ event: 'page_view' })`,
]
const parenthesizedEvents = [
  `(gtag)('event', 'page_view')`,
  `(window.gtag)('event', 'page_view')`,
  `((window.gtag))('event', 'page_view')`,
  `(window['gtag'])('event', 'page_view')`,
  `(window?.gtag)?.('event', 'page_view')`,
  `(window?.["gtag"])?.('event', 'page_view')`,
  `const snippet = "(gtag)('event', 'page_view')"`,
]
const aliasEvents = [
  `const emit = window.gtag; emit('event', 'page_view')`,
  `const emit = gtag; emit?.('event', 'page_view')`,
  `const emit = window?.['gtag']; (emit)?.('event', 'page_view')`,
  `const { gtag: emit } = window; emit('event', 'page_view')`,
  `const { ['gtag']: emit } = globalThis; emit?.('event', 'page_view')`,
  `const { push: emit } = window.dataLayer; emit({ event: 'page_view' })`,
  `const { ['push']: emit } = window?.['dataLayer']; emit?.({ event: 'page_view' })`,
  `const emit = window.dataLayer.push; emit({ event: 'page_view' })`,
  `const first = window.gtag; const emit = first; emit('event', 'page_view')`,
  `const emit = window.gtag; function send() { emit('event', 'page_view') }`,
  `const emit = (window.gtag)!; emit?.('event', 'page_view')`,
]
const allowedAliases = [
  `const emit = window.gtag; emit('consent', 'update', {})`,
  `const { gtag: emit } = window; emit?.('config', 'G-example')`,
  `const { push: emit } = queue; emit({ event: 'page_view' })`,
  `// oxlint-disable no-shadow\nconst emit = window.gtag; function send(emit) { emit('event', 'page_view') }`,
  `function setup() { const emit = window.gtag } function send() { const emit = log; emit('event', 'page_view') }`,
]
const allowedCommands = [
  `(gtag)('consent', 'update', {})`,
  `(window.gtag)('config', 'G-example')`,
  `((window?.["gtag"]))?.('consent', 'update', {})`,
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
    ...parenthesizedEvents,
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

test('supported lint configuration executes the rule for member access and parenthesized callees', () => {
  const directory = mkdtempSync(
    join(root, 'apps/web/app/analytics-lint-fixture-'),
  )
  try {
    const rejected = [...memberEvents, ...parenthesizedEvents, ...aliasEvents]
    const valid = [
      ...allowedCommands,
      ...allowedAliases.map((text) => `{ ${text} }`),
    ].join('\n')
    const results = lintCases(directory, '.oxlintrc.json', [
      ...rejected.map((text) => ({ text, name: 'example.ts' })),
      { text: valid, name: 'example.ts' },
    ])
    rejected.forEach((text, index) =>
      assert.ok(results[index].typedSender, text + results[index].output),
    )
    assert.deepEqual(results.at(-1).errors, [], results.at(-1).output)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('plugin detects extracted senders with lexical scope and preserves file exclusions', () => {
  const directory = mkdtempSync(
    join(root, 'apps/web/app/analytics-lint-fixture-'),
  )
  try {
    const config = join(directory, 'oxlint.json')
    writeFileSync(
      config,
      JSON.stringify({
        jsPlugins: [join(root, 'scripts/analytics-lint-plugin.mjs')],
        categories: { correctness: 'off' },
        rules: { 'analytics/typed-sender': 'error' },
      }),
    )
    const cases = [
      ...aliasEvents.map((text) => [text, 'example.ts', true]),
      ...allowedAliases.map((text) => [text, 'example.ts', false]),
      ...aliasEvents.map((text) => [text, 'example.test.ts', false]),
      [aliasEvents[0], 'example.js', false],
    ]
    const results = lintCases(
      directory,
      config,
      cases.map(([text, name]) => ({ text, name })),
    )
    cases.forEach(([text, , rejected], index) => {
      const result = results[index]
      if (rejected) assert.ok(result.typedSender, text + result.output)
      else assert.deepEqual(result.errors, [], text + result.output)
    })
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
