import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

const root = resolve(import.meta.dirname, '..')
test('real Oxlint rejects dangerous waits and interactions, accepts capability, cleanup and time contracts', () => {
  const directory = mkdtempSync(join(root, 'test-reliability-fixture-'))
  const lint = (name, code) => {
    const file = join(directory, name)
    writeFileSync(file, code)
    const result = spawnSync(
      'pnpm',
      ['exec', 'vp', 'lint', '-c', '.oxlintrc.json', file],
      { cwd: root, encoding: 'utf8' },
    )
    return { status: result.status, output: result.stdout + result.stderr }
  }
  try {
    for (const [name, source] of Object.entries({
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
    })) {
      const result = lint(`${name}.test.ts`, source)
      assert.notEqual(result.status, 0, result.output)
      assert.match(result.output, /test-reliability[(/]observed-waits/, name)
    }
    const good = lint(
      'good.test.ts',
      `
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
`,
    )
    assert.equal(good.status, 0, good.output)
    const production = lint('production.ts', 'button?.click()')
    assert.equal(production.status, 0, production.output)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
