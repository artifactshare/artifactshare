import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { collectTestChanges, renderTestChanges } from './test-change-review.mjs'

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'test-change-review-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const run = (file, args) =>
    execFileSync(file, args, { cwd: root, encoding: 'utf8' })
  const git = (...args) => run('git', args).trim()
  git('init', '-q')
  git('config', 'core.hooksPath', '/dev/null')
  git('config', 'commit.gpgsign', 'false')
  const write = (file, text) => {
    mkdirSync(dirname(join(root, file)), { recursive: true })
    writeFileSync(join(root, file), text)
  }
  const commit = () => {
    git('add', '.')
    git(
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.com',
      'commit',
      '-qm',
      'fixture',
    )
    return git('rev-parse', 'HEAD')
  }
  return { root, run, write, commit }
}

test('real fixed diffs expose test-selection, limit, assertion and fixture changes without source text', (t) => {
  const f = fixture(t)
  const file = 'app/test/check name.test.ts'
  f.write(
    file,
    `test('work', async () => {\n const fixture = { count: 1000 }\n await wait({ timeout: 1000 })\n expect(result).toBe(true) // SHOULD_NOT_APPEAR\n})\n`,
  )
  f.write('src/product.ts', 'assert(true)\n')
  const base = f.commit()
  f.write(
    file,
    `test.skip('work', async () => {\n const fixture = { count: 1 }\n await wait({ timeout: 5000, retry: 1 })\n})\n`,
  )
  f.write('src/product.ts', '')
  const head = f.commit()
  const report = collectTestChanges({ base, head, run: f.run })
  assert.deepEqual(
    report.files.map((row) => row.file),
    [file],
  )
  const notes = report.files[0].notes
  for (const kind of [
    'test-selection',
    'execution-limit',
    'removed-assertion',
    'fixture-load',
  ])
    assert.ok(
      notes.some((note) => note.kind === kind),
      kind,
    )
  assert.ok(
    notes.some(
      (note) =>
        note.kind === 'removed-assertion' &&
        note.line === 4 &&
        note.side === 'removed',
    ),
  )
  assert.equal(report.base, base)
  assert.equal(report.head, head)
  assert.ok(!JSON.stringify(report).includes('SHOULD_NOT_APPEAR'))
  assert.match(renderTestChanges(report), /syntactic review cues/)
  assert.deepEqual(
    collectTestChanges({ base: head, head, run: f.run }).files,
    [],
  )
  assert.throws(
    () => collectTestChanges({ base: base.slice(0, 8), head, run: f.run }),
    /fixed full/,
  )
  assert.throws(() =>
    collectTestChanges({ base, head: 'f'.repeat(40), run: f.run }),
  )
})

test('deleted tests and capped observations remain explicit', (t) => {
  const f = fixture(t)
  f.write('app/test/deleted.test.ts', 'expect(true).toBe(true)\n')
  f.write('app/test/load.test.ts', '')
  const base = f.commit()
  rmSync(join(f.root, 'app/test/deleted.test.ts'))
  f.write(
    'app/test/load.test.ts',
    Array.from(
      { length: 60 },
      (_, i) => `const item${i} = { count: ${i} }`,
    ).join('\n'),
  )
  const head = f.commit()
  const report = collectTestChanges({ base, head, run: f.run })
  assert.equal(
    report.files.find((row) => row.status === 'D').notes[0].kind,
    'removed-test-file',
  )
  const load = report.files.find((row) => row.file.endsWith('load.test.ts'))
  assert.equal(load.notes.length, 40)
  assert.equal(load.omitted, 20)
})
