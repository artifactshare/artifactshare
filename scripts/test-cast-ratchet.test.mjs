import assert from 'node:assert/strict'
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
  symlinkSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { test } from 'node:test'
import {
  analyzeTree,
  assertionErrors,
  baselinePath,
  builderFiles,
  checkTestCasts,
  inventory,
} from './test-cast-ratchet.mjs'

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'cast-ratchet-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const put = (file, source) => {
    mkdirSync(dirname(join(root, file)), { recursive: true })
    writeFileSync(join(root, file), source)
  }
  mkdirSync(join(root, 'packages'))
  for (const file of builderFiles) put(file, 'export const value: number = 1')
  put('apps/web/example.test.ts', 'const value = {} as unknown as Example\n')
  const baseline = inventory(root).counts
  put(baselinePath, JSON.stringify(baseline))
  assert.deepEqual(analyzeTree(root, baseline).errors, [])
  return { root, put, baseline }
}

test('equality and reductions pass; updating records reductions and refuses growth', (t) => {
  const { root, put, baseline } = fixture(t)
  assert.match(checkTestCasts(root), /ceiling 1/)
  put('apps/web/example.test.ts', '')
  assert.match(checkTestCasts(root), /--update-baseline/)
  assert.deepEqual(JSON.parse(readFileSync(join(root, baselinePath))), baseline)
  checkTestCasts(root, { update: true })
  assert.deepEqual(JSON.parse(readFileSync(join(root, baselinePath))), {})
  put('apps/web/example.test.ts', '// as unknown as Example')
  assert.throws(
    () => checkTestCasts(root, { update: true }),
    /exceeds ceiling 0/,
  )
  assert.deepEqual(JSON.parse(readFileSync(join(root, baselinePath))), {})
  rmSync(join(root, 'apps/web/example.test.ts'))
  assert.deepEqual(analyzeTree(root, baseline).errors, [])
})

test('existing and new file growth fail with locations and guidance; decreases cannot offset growth', (t) => {
  const { root, put } = fixture(t)
  put(
    'apps/web/example.test.ts',
    '// as unknown as A\nconst b = "as unknown as B"; const c = "as unknown as C"\n',
  )
  assert.throws(
    () => checkTestCasts(root),
    (error) => {
      for (const text of [
        '3 occurrences exceeds ceiling 1',
        'example.test.ts:1:4',
        'example.test.ts:2:12',
        'example.test.ts:2:41',
        'candidate locations',
        'cliAuthority',
        'workerEnv',
        'stripeClient',
        'parentWindow',
        'dataTransfer',
        'd1Database',
        'Deliberately invalid',
        '--update-baseline',
      ])
        assert.ok(error.message.includes(text), text)
      return true
    },
  )
  put('apps/web/example.test.ts', '')
  put('packages/example/new.test.tsx', '// as unknown as A')
  assert.throws(
    () => checkTestCasts(root),
    /packages\/example\/new.test.tsx: 1 occurrences exceeds ceiling 0/,
  )
})

test('inventory counts helper files and package mjs once, including comments and strings, excluding production and caches', (t) => {
  const { root, put, baseline } = fixture(t)
  put(
    'apps/web/app/test/example.test.ts',
    '// as unknown as A\n"as unknown as B"',
  )
  put('apps/web/app/test/guide.md', 'as unknown as A')
  put('packages/example/check.test.mjs', '// as unknown as A')
  for (const file of [
    'apps/web/source.ts',
    'packages/example/node_modules/check.test.ts',
    'apps/web/dist/check.test.ts',
    'apps/web/.cache/check.test.ts',
  ])
    put(file, '// as unknown as A')
  symlinkSync(join(root, 'packages'), join(root, 'apps/linked'), 'dir')
  assert.deepEqual(inventory(root).counts, {
    'apps/web/app/test/example.test.ts': 2,
    'apps/web/app/test/guide.md': 1,
    'apps/web/example.test.ts': 1,
    'packages/example/check.test.mjs': 1,
  })
  assert.equal(analyzeTree(root, baseline).errors.length, 3)
})

test('builder parser allows checked construction, const and satisfies; rejects assertions independently of cast counts', (t) => {
  const file = builderFiles[0]
  assert.deepEqual(
    assertionErrors(
      'const a: number = 1; const b = [a] as const; const c = {a} satisfies {a: number}',
      file,
    ),
    [],
  )
  for (const source of [
    'const a = value as Example',
    'const a = value as unknown as Example',
    'const a = <Example>value',
    'const a = value!',
  ]) {
    const errors = assertionErrors(`\n${source}`, file)
    assert.ok(errors.length > 0)
    assert.match(errors[0], /cli-authority.ts:2: forbidden/)
  }
  const { root, put } = fixture(t)
  put(file, 'const a = value as Example')
  assert.throws(() => checkTestCasts(root), /forbidden TSAsExpression/)
  put(file, 'const =')
  assert.throws(() => checkTestCasts(root), /parse error/)
  rmSync(join(root, file))
  assert.throws(() => checkTestCasts(root), /missing registered builder/)
})

test('CLI exit status and public audit propagate the ratchet failure', (t) => {
  // Subprocesses witness the executable exit code and audit integration; analysis stays in process above.
  const { root, put } = fixture(t)
  const run = (script) =>
    spawnSync(process.execPath, [resolve('scripts', script)], {
      cwd: root,
      encoding: 'utf8',
    })
  assert.equal(run('test-cast-ratchet.mjs').status, 0)
  put('apps/web/new.test.ts', '// as unknown as Example')
  const failed = run('test-cast-ratchet.mjs')
  assert.equal(failed.status, 1)
  assert.match(failed.stderr, /apps\/web\/new.test.ts:1:4/)
  assert.match(failed.stderr, /typed-fakes\/cli-authority.ts/)
  put('package.json', readFileSync('package.json', 'utf8'))
  put('apps/web/package.json', readFileSync('apps/web/package.json', 'utf8'))
  put(
    'apps/web/app/services/slack-notifications.server.test.ts',
    "test.skipIf(globalThis.process.env.PUBLIC_TEST === '1')",
  )
  for (const file of [
    'app/lib/gap-audit.browser.test.tsx',
    'app/root.locale.browser.test.tsx',
    'app/routes/dev.gallery/gallery.browser.test.tsx',
    'app/routes/dev.scenarios.$scenario/scenarios.browser.test.tsx',
  ])
    put(`apps/web/${file}`, '')
  const audit = run('public-test-audit.mjs')
  assert.equal(audit.status, 1)
  assert.match(audit.stderr, /new.test.ts: 1 occurrences exceeds ceiling 0/)
  put('apps/web/new.test.ts', '')
  const healthy = run('public-test-audit.mjs')
  assert.equal(healthy.status, 0, healthy.stderr)
})
