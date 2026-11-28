import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import test from 'node:test'
import { MESSAGE } from './file-url-path-lint-plugin.mjs'
import { lintFixturePrefix } from './lib/lint-fixture-paths.mjs'

const root = resolve(import.meta.dirname, '..')

// The rule reads the AST, so the fixture can spell every denied shape. Each
// line the rule must report carries the marker; a reported shape that spans
// lines is marked where its expression starts, which is where oxlint points.
const MARKER = '// flag'

// A comment and a string that spell the shape, the pathname of a request URL,
// a file URL left as a URL, and fileURLToPath itself must all stay silent.
const FIXTURE = `import { fileURLToPath } from 'node:url'
// new URL('..', import.meta.url).pathname spelled in a comment
const documented = "new URL('..', import.meta.url).pathname"
export const a = new URL('..', import.meta.url).pathname ${MARKER}
export const b = new URL('..', import.meta.url)['pathname'] ${MARKER}
export const { pathname: c } = new URL('..', import.meta.url) ${MARKER}
const { pathname } = new URL('..', import.meta.url) ${MARKER}
export const d = new URL( ${MARKER}
  '../db/migrations',
  import.meta.url,
).pathname
export const self = new URL(import.meta.url).pathname ${MARKER}
let assigned = ''
;({ pathname: assigned } = new URL('..', import.meta.url)) ${MARKER}
export const kept = fileURLToPath(new URL('..', import.meta.url))
export const href = new URL('..', import.meta.url).href
export const requested = new URL(String(documented)).pathname
export { a as aa, b as bb, c as cc, pathname, d as dd, assigned }
`

function lintFixture(content) {
  const directory = mkdtempSync(join(root, lintFixturePrefix('file-url-path')))
  try {
    const file = join(directory, 'example.ts')
    writeFileSync(file, content)
    const result = spawnSync(
      'pnpm',
      ['exec', 'vp', 'lint', '-c', '.oxlintrc.json', '-f', 'json', file],
      { cwd: root, encoding: 'utf8' },
    )
    const output = result.stdout + result.stderr
    assert.ok([0, 1].includes(result.status), output)
    const report = JSON.parse(result.stdout.slice(result.stdout.indexOf('{')))
    return report.diagnostics
      .filter(
        (diagnostic) =>
          diagnostic.filename === relative(root, file) &&
          /file-url-path[(/]no-url-pathname/.test(diagnostic.code),
      )
      .map((diagnostic) => ({
        line: diagnostic.labels[0].span.line,
        message: diagnostic.message,
      }))
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

test('the configured lint reports every read of a file URL pathname', () => {
  const expected = FIXTURE.split('\n')
    .map((line, index) => (line.includes(MARKER) ? index + 1 : 0))
    .filter(Boolean)
  assert.equal(expected.length, 7)
  const reported = lintFixture(FIXTURE)
  assert.deepEqual(
    reported.map(({ line }) => line).sort((a, b) => a - b),
    expected,
  )
  for (const { message } of reported) assert.equal(message, MESSAGE)
})
