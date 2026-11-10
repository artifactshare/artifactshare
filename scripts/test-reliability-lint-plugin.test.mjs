import assert from 'node:assert/strict'
import {
  mkdtempSync,
  writeFileSync,
  rmSync,
  mkdirSync,
  readFileSync,
  realpathSync,
} from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

const root = resolve(import.meta.dirname, '..')
test('real Oxlint rejects dangerous waits and interactions, accepts capability, cleanup and time contracts', () => {
  const directory = mkdtempSync(join(tmpdir(), 'test-reliability-fixture-'))
  const lint = (sources) => {
    const files = Object.entries(sources).map(([name, code]) => {
      const file = join(directory, name)
      writeFileSync(file, code)
      return file
    })
    const result = spawnSync(
      'pnpm',
      [
        'exec',
        'vp',
        'lint',
        '-c',
        '.oxlintrc.json',
        '--format',
        'json',
        ...files,
      ],
      { cwd: root, encoding: 'utf8' },
    )
    return {
      status: result.status,
      output: result.stdout + result.stderr,
      json: result.stdout,
    }
  }
  try {
    const bad = {
      wait: 'page.waitForFunction(() => true).catch(() => undefined)',
      empty: 'page.waitForSelector("ready").catch(() => {})',
      assertion:
        'expect.poll(read).toBe(true).catch(() => { return undefined })',
      logging:
        'page.waitForSelector("ready").catch(error => { console.warn("not ready", error) })',
      loggingExpression:
        'page.waitForFunction(probe).catch(error => console.error(error))',
      returnedLogging:
        'page.waitForSelector("ready").catch(error => { return console.warn(error) })',
      null: 'page.waitForFunction(probe).catch(() => null)',
      false: 'page.waitForFunction(probe).catch(() => { return false })',
      thenFailure: 'page.waitForFunction(probe).then(ok, () => false)',
      chained: 'page.waitForFunction(probe).then(ok).catch(() => false)',
      chainedLogging:
        'page.waitForFunction(probe).then(ok).finally(cleanup).catch(error => { console.warn(error); return null })',
      optional: 'host.querySelector("button")?.click()',
      optionalMethod: 'button.click?.()',
      sleep: 'await page.waitForTimeout(100)',
    }
    const rejected = lint(
      Object.fromEntries(
        Object.entries(bad).map(([name, source]) => [
          `${name}.test.ts`,
          source,
        ]),
      ),
    )
    assert.notEqual(rejected.status, 0, rejected.output)
    const diagnostics = JSON.parse(rejected.json).diagnostics
    for (const name of Object.keys(bad)) {
      assert.ok(
        diagnostics.some(
          (row) =>
            row.filename.endsWith(`${name}.test.ts`) &&
            row.code.includes('observed-waits'),
        ),
        name,
      )
    }
    const good = lint({
      'good.test.ts': `
await page.waitForFunction(() => true)
const supported = await page.waitForFunction(probe).then(() => true).catch(error => {
  if (error.name !== 'TimeoutError') throw error
  return false
})
expect(supported).toBe(false)
await page.waitForFunction(probe).then(ok, error => {
  if (error.name !== 'TimeoutError') throw error
  return false
})
await page.waitForFunction(probe).catch(error => { console.warn(error); throw error })
await reader.cancel().catch(() => undefined)
await context.close().catch(() => null)
button!.click()
// test-wait: elapsed-time — no late counts may appear after the query is cleared.
await page.waitForTimeout(1000)
setTimeout(() => server.close(), 100)
async function elapsed() {
  // test-wait: elapsed-time — verify the absence of a late delivery.
  return page.waitForTimeout(100)
}
// test-wait: elapsed-time — verify the absence of a late delivery.
const expired = await page.waitForTimeout(100)
`,
      'production.ts': 'button?.click()',
    })
    assert.equal(good.status, 0, good.output)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('a clone beneath test does not classify production as a test and still checks repository helpers', () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'lint-clone-')))
  const clone = join(directory, 'test', 'repository')
  const script = join(clone, 'scripts')
  const helper = join(clone, 'apps', 'web', 'app', 'test')
  mkdirSync(script, { recursive: true })
  mkdirSync(helper, { recursive: true })
  writeFileSync(
    join(script, 'plugin.mjs'),
    readFileSync(join(root, 'scripts/test-reliability-lint-plugin.mjs')),
  )
  writeFileSync(
    join(clone, '.oxlintrc.json'),
    JSON.stringify({
      jsPlugins: ['./scripts/plugin.mjs'],
      rules: { 'test-reliability/observed-waits': 'error' },
    }),
  )
  const production = join(clone, 'apps', 'web', 'app', 'component.ts')
  const testHelper = join(helper, 'command.ts')
  writeFileSync(production, 'button?.click()')
  writeFileSync(testHelper, 'button?.click()')
  try {
    const result = spawnSync(
      'pnpm',
      [
        'exec',
        'vp',
        'lint',
        '-c',
        join(clone, '.oxlintrc.json'),
        '--format',
        'json',
        production,
        testHelper,
      ],
      { cwd: root, encoding: 'utf8' },
    )
    assert.notEqual(result.status, 0, result.stdout + result.stderr)
    const diagnostics = JSON.parse(result.stdout).diagnostics.filter((row) =>
      row.code.includes('observed-waits'),
    )
    assert.equal(diagnostics.length, 1)
    assert.ok(diagnostics[0].filename.endsWith('apps/web/app/test/command.ts'))
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
