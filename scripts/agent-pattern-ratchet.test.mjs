import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'

const root = resolve(import.meta.dirname, '..')
const script = join(root, 'scripts/agent-pattern-ratchet.mjs')
const fixtures = join(root, 'scripts/fixtures/agent-pattern-ratchet')
const env = Object.fromEntries(
  Object.entries(process.env).filter(
    ([name]) =>
      !['CI', 'AGENT_RATCHET_BASE'].includes(name) && !name.startsWith('GIT_'),
  ),
)

function repository(t) {
  const directory = mkdtempSync(join(tmpdir(), 'agent-pattern-ratchet-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const git = (...args) =>
    execFileSync('git', args, { cwd: directory, encoding: 'utf8', env })
  git('init', '-q', '-b', 'main')
  git('config', 'user.email', 'test@example.com')
  git('config', 'user.name', 'Ratchet Test')
  git('config', 'commit.gpgsign', 'false')
  const write = (files) => {
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(dirname(join(directory, path)), { recursive: true })
      writeFileSync(join(directory, path), text)
    }
  }
  const commit = (message) => {
    git('add', '-A')
    git('commit', '-q', '--no-verify', '--allow-empty', '-m', message)
    return git('rev-parse', 'HEAD').trim()
  }
  const run = (args = [], extra = {}) =>
    spawnSync(process.execPath, [script, ...args], {
      cwd: directory,
      encoding: 'utf8',
      env: { ...env, ...extra },
    })
  const replay = (fixture, from = `${fixture}/base`) => {
    cpSync(join(fixtures, from), directory, { recursive: true })
    const base = commit('base')
    git('rm', '-rq', '--', '.')
    cpSync(join(fixtures, fixture, 'head'), directory, { recursive: true })
    const head = commit('head')
    return run(['--base', base, '--head', head])
  }
  return { directory, git, write, commit, run, replay }
}

test('fails on the comment fda6f9d added inside the preview shell inline script', (t) => {
  const result = repository(t).replay('comment-panel-rebuild')
  assert.equal(result.status, 1, result.stdout)
  assert.match(result.stderr, /comment rose from 2 to 5 in 1 changed file/)
  assert.match(
    result.stderr,
    /packages\/cli\/src\/preview\/shell\.ts:5 "Saves, screen reports and anchor verdicts/,
  )
  assert.match(result.stderr, /fix: put the reason in a name, a type, a test/)
})

test('fails on the effect, timer and comments the initial frame focus added', (t) => {
  const result = repository(t).replay('initial-focus')
  assert.equal(result.status, 1, result.stdout)
  const frame = 'apps/web/app/routes/a.$id/+components/sandbox-frame.tsx'
  assert.match(result.stderr, /effect rose from 0 to 1/)
  assert.ok(result.stderr.includes(`${frame}:55 useEffect`), result.stderr)
  assert.match(result.stderr, /timer rose from 1 to 2/)
  assert.ok(result.stderr.includes(`${frame}:48 setTimeout`), result.stderr)
  assert.match(result.stderr, /comment rose from 0 to 8/)
  for (const line of [28, 40, 46, 57])
    assert.ok(result.stderr.includes(`${frame}:${line} "`), result.stderr)
  assert.match(result.stderr, /fix: compute the value during render/)
  assert.match(result.stderr, /fix: wait for an observed condition/)
})

test('fails on the polling timer the search capture added', (t) => {
  const result = repository(t).replay('search-capture-poll')
  assert.equal(result.status, 1, result.stdout)
  assert.match(result.stderr, /timer rose from 0 to 1/)
  assert.match(
    result.stderr,
    /apps\/web\/app\/services\/auth\.server\.ts:35 setTimeout/,
  )
  assert.match(result.stderr, /AbortSignal\.timeout/)
  assert.match(result.stderr, /comment rose from 0 to 3/)
})

test('fails on the effect that reacts to a settings fetcher result', (t) => {
  const result = repository(t).replay('settings-fetcher-result')
  assert.equal(result.status, 1, result.stdout)
  assert.match(result.stderr, /effect rose from 0 to 1/)
  assert.match(result.stderr, /integrations\.tsx:10 useEffect/)
  assert.doesNotMatch(result.stderr, /timer rose|comment rose/)
})

test('passes when the same effect, timer and comments move into a hook file', (t) => {
  const result = repository(t).replay('move-to-hook', 'initial-focus/head')
  assert.equal(result.status, 0, result.stderr)
  assert.match(
    result.stdout,
    /ok \(effect 1 -> 1, timer 2 -> 2, comment 8 -> 8 in 2 changed files/,
  )
})

test('passes a rename and a change that removes occurrences', (t) => {
  const repo = repository(t)
  repo.write({
    'apps/web/app/panel.ts':
      'export function open() {\n  // Open the panel.\n  setTimeout(open, 10)\n}\n',
  })
  const base = repo.commit('base')
  repo.git('mv', 'apps/web/app/panel.ts', 'apps/web/app/side-panel.ts')
  const renamed = repo.commit('rename')
  assert.equal(repo.run(['--base', base, '--head', renamed]).status, 0)
  repo.write({ 'apps/web/app/side-panel.ts': 'export function open() {}\n' })
  const removed = repo.run(['--base', base])
  assert.equal(removed.status, 0, removed.stderr)
  assert.match(removed.stdout, /timer 1 -> 0, comment 1 -> 0/)
})

test('does not count tool directives with a reason, vendor quirks, compat notes, tested invariants, JSDoc types in JavaScript, or agent-allow lines', (t) => {
  const repo = repository(t)
  repo.write({ 'apps/web/app/frame.tsx': 'export {}\n' })
  const base = repo.commit('base')
  repo.write({
    'apps/web/app/frame.test.ts': 'export {}\n',
    'apps/web/app/frame.tsx': [
      '/// <reference types="vite/client" />',
      "import { useEffect } from 'react'",
      '// oxlint-disable-next-line no-shadow -- the inner name mirrors the DOM API',
      '// react-doctor-disable-next-line react-doctor/no-event-handler -- the parent owns the event',
      '// @ts-expect-error the DOM types lag the spec',
      '// quirk(webkit): pageshow fires before load on a back navigation,',
      '// so the restore runs from pageshow.',
      '// compat: CLI 0.4 still sends the token as a query parameter.',
      '// invariant: one thread per anchor (test: apps/web/app/frame.test.ts)',
      'export const load = (path: string) => import(/* @vite-ignore */ path)',
      'export function Frame() {',
      '  // agent-allow(effect): subscribes to the frame message port',
      '  useEffect(() => {}, [])',
      '  setTimeout(tick, 1000) // agent-allow(timer): the countdown shows whole seconds',
      '  // agent-allow(comment): the vendored license header stays verbatim',
      '  return null',
      '}',
      '',
    ].join('\n'),
    'apps/web/app/lib/gap.js':
      '/** @param {Element} element */\nexport const box = (element) => element.getBoundingClientRect()\n',
  })
  const result = repo.run(['--base', base])
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /effect 0 -> 0, timer 0 -> 0, comment 0 -> 0/)
  assert.match(
    result.stdout,
    /allowed effect at apps\/web\/app\/frame\.tsx:13: subscribes to the frame message port/,
  )
  assert.match(result.stdout, /allowed timer at apps\/web\/app\/frame\.tsx:14/)
  assert.match(
    result.stdout,
    /allowed comment at apps\/web\/app\/frame\.tsx:15/,
  )
})

test('counts a directive, quirk, invariant or agent-allow that does not hold', (t) => {
  const repo = repository(t)
  repo.write({ 'apps/web/app/frame.tsx': 'export {}\n' })
  const base = repo.commit('base')
  repo.write({
    'apps/web/app/frame.tsx': [
      '// react-doctor-disable-next-line react-doctor/no-event-handler',
      'export const a = 1',
      '// quirk(netscape): frames reload twice',
      'export const b = 2',
      '// invariant: one thread per anchor (test: apps/web/app/missing.test.ts)',
      'export const c = 3',
      '// agent-allow(effect):',
      'export const d = 4',
      '// agent-allow(timer): the countdown shows whole seconds',
      'export const e = 5',
      '',
    ].join('\n'),
  })
  const result = repo.run(['--base', base])
  assert.equal(result.status, 1, result.stdout)
  assert.match(result.stderr, /comment rose from 0 to 5/)
  assert.match(result.stderr, /frame\.tsx:1 .*directive without a reason/)
  assert.match(result.stderr, /frame\.tsx:3 .*"netscape" is not in the list/)
  assert.match(
    result.stderr,
    /frame\.tsx:5 .*apps\/web\/app\/missing\.test\.ts is not a tracked file/,
  )
  assert.match(result.stderr, /frame\.tsx:7 .*agent-allow needs a reason/)
  assert.match(
    result.stderr,
    /frame\.tsx:9 .*not on the line above a timer call/,
  )
})

test('counts effects and timers in product code, comments in scripts too, and nothing in tests, fixtures or generated files', (t) => {
  const repo = repository(t)
  const base = repo.commit('base')
  const sample =
    '// Wait for the frame.\nuseEffect(() => {}, [])\nsetTimeout(check, 400)\n'
  repo.write({
    'apps/web/app/routes/page.test.tsx': sample,
    'apps/web/app/test/command.ts': sample,
    'apps/web/fixtures/site.ts': sample,
    'packages/viewer-kit/src/reporter.generated.ts': sample,
    'scripts/screens.mjs': sample,
    'packages/cli/src/preview/page.ts':
      'export const page = () => `<script>\n  setTimeout(checkOrphans, 400);\n</script>`\n',
  })
  const result = repo.run(['--base', base])
  assert.equal(result.status, 1, result.stdout)
  assert.match(result.stderr, /comment rose from 0 to 1 in 2 changed files/)
  assert.match(result.stderr, /scripts\/screens\.mjs:1 "Wait for the frame\."/)
  assert.match(result.stderr, /timer rose from 0 to 1/)
  assert.match(
    result.stderr,
    /packages\/cli\/src\/preview\/page\.ts:2 setTimeout/,
  )
  assert.doesNotMatch(result.stderr, /effect rose/)
})

test('checks uncommitted and untracked work against the merge base with origin/main', (t) => {
  const repo = repository(t)
  repo.write({ 'apps/web/app/panel.ts': 'export const panel = 1\n' })
  repo.commit('base')
  repo.git('update-ref', 'refs/remotes/origin/main', 'HEAD')
  repo.git('checkout', '-q', '-b', 'work')
  repo.write({ 'apps/web/app/panel.ts': 'export const panel = 2\n' })
  repo.commit('work')
  repo.write({
    'apps/web/app/listener.tsx':
      'export const listen = () => useEffect(() => {}, [])\n',
  })
  const result = repo.run()
  assert.equal(result.status, 1, result.stdout)
  assert.match(result.stderr, /effect rose from 0 to 1 in 2 changed files/)
  assert.match(result.stderr, /apps\/web\/app\/listener\.tsx:1 useEffect/)
})

test('fails closed in CI without a base and compares with AGENT_RATCHET_BASE when set', (t) => {
  const repo = repository(t)
  const base = repo.commit('base')
  repo.write({ 'apps/web/app/panel.ts': 'export const panel = 1\n' })
  repo.commit('change')
  const missing = repo.run([], { CI: 'true' })
  assert.equal(missing.status, 1)
  assert.match(missing.stderr, /CI must name the base; set AGENT_RATCHET_BASE/)
  const named = repo.run([], { CI: 'true', AGENT_RATCHET_BASE: base })
  assert.equal(named.status, 0, named.stderr)
  assert.match(named.stdout, /in 1 changed file since/)
})

test('counts comment lines, so growing a comment or hanging lines under a tag fails', (t) => {
  const repo = repository(t)
  const kept = [
    '// Opens the panel.',
    '// Keeps focus.',
    'export const panel = 1',
    '// quirk(react): a short quirk',
    '// stays free.',
    'export const other = 2',
  ]
  repo.write({ 'apps/web/app/panel.ts': [...kept, ''].join('\n') })
  const base = repo.commit('base')
  repo.write({
    'apps/web/app/panel.ts': [
      ...kept.slice(0, 2),
      '// And restores it on close.',
      ...kept.slice(2),
      '// quirk(react): strict mode runs effects twice,',
      '// so the panel opens once per mount,',
      '// which the reader sees as a flicker,',
      '// on every route change.',
      'export const third = 3',
      '',
    ].join('\n'),
  })
  const result = repo.run(['--base', base])
  assert.equal(result.status, 1, result.stdout)
  assert.match(result.stderr, /comment rose from 2 to 7/)
  assert.match(result.stderr, /panel\.ts:1 "Opens the panel\."/)
  assert.match(
    result.stderr,
    /panel\.ts:8 "quirk\(react\): .*a tag covers a comment of at most 3 lines/,
  )
})

test('counts effects and timers called through an import alias', (t) => {
  const repo = repository(t)
  const base = repo.commit('base')
  repo.write({
    'apps/web/app/frame.tsx': [
      "import { useEffect as ue, useInsertionEffect } from 'react'",
      "import { setTimeout as sleep } from 'node:timers/promises'",
      "import { setInterval as every } from 'timers'",
      'export function Frame() {',
      '  ue(() => {}, [])',
      '  useInsertionEffect(() => {}, [])',
      '  return null',
      '}',
      'export const wait = () => sleep(10)',
      'export const poll = () => every(check, 100)',
      '',
    ].join('\n'),
    'apps/web/app/local.ts':
      'const sleep = (ms: number) => ms\nconst ue = () => 1\nexport const value = sleep(ue())\n',
  })
  const result = repo.run(['--base', base])
  assert.equal(result.status, 1, result.stdout)
  assert.match(result.stderr, /effect rose from 0 to 2/)
  assert.match(result.stderr, /frame\.tsx:5 useEffect/)
  assert.match(result.stderr, /frame\.tsx:6 useInsertionEffect/)
  assert.match(result.stderr, /timer rose from 0 to 2/)
  assert.match(result.stderr, /frame\.tsx:9 setTimeout/)
  assert.match(result.stderr, /frame\.tsx:10 setInterval/)
  assert.doesNotMatch(result.stderr, /local\.ts/)
})

test('admits an invariant only when it names a tracked test file', (t) => {
  const repo = repository(t)
  repo.write({
    '.gitignore': 'apps/web/app/ignored.test.ts\n',
    'apps/web/app/frame.ts': 'export {}\n',
    'apps/web/app/frame.test.ts': 'export {}\n',
    'apps/web/app/panel.ts': 'export {}\n',
    'apps/web/app/ignored.test.ts': 'export {}\n',
  })
  const base = repo.commit('base')
  repo.write({
    'apps/web/app/panel.ts': [
      '// invariant: one panel per route (test: apps)',
      'export const a = 1',
      '// invariant: one panel per route (test: apps/web/app/frame.ts)',
      'export const b = 2',
      '// invariant: one panel per route (test: apps/web/app/ignored.test.ts)',
      'export const c = 3',
      '// invariant: one panel per route (test: apps/web/app/frame.test.ts)',
      'export const d = 4',
      '',
    ].join('\n'),
  })
  const expectFailures = (result) => {
    assert.equal(result.status, 1, result.stdout)
    assert.match(result.stderr, /comment rose from 0 to 3/)
    assert.match(result.stderr, /panel\.ts:1 .*test apps is not a test file/)
    assert.match(result.stderr, /panel\.ts:3 .*frame\.ts is not a test file/)
    assert.match(
      result.stderr,
      /panel\.ts:5 .*ignored\.test\.ts is not a tracked file/,
    )
  }
  expectFailures(repo.run(['--base', base]))
  const head = repo.commit('head')
  expectFailures(repo.run(['--base', base, '--head', head]))
})

test('does not count a protocol-relative URL at the start of a template line', (t) => {
  const repo = repository(t)
  const base = repo.commit('base')
  repo.write({
    'packages/cli/src/preview/page.ts': [
      'export const sources = `',
      '  //cdn.example.com/lib.js',
      '  //fonts.example.net:443/a.css',
      '`',
      'export const note = `',
      '  // the fonts load after the script',
      '`',
      '',
    ].join('\n'),
  })
  const result = repo.run(['--base', base])
  assert.equal(result.status, 1, result.stdout)
  assert.match(result.stderr, /comment rose from 0 to 1/)
  assert.match(result.stderr, /page\.ts:6 "the fonts load after the script"/)
  assert.doesNotMatch(result.stderr, /example\.(?:com|net)/)
})

test('counts an effect or timer passed or reached by reference, but not in types or typeof checks', (t) => {
  const repo = repository(t)
  const base = repo.commit('base')
  repo.write({
    'apps/web/app/frame.tsx': [
      "import React, { useEffect, useLayoutEffect } from 'react'",
      'export const paint = () => new Promise(requestAnimationFrame)',
      'export const later = (f: () => void) => (0, setTimeout)(f, 1)',
      'export const bound = (f: () => void) => setTimeout.call(globalThis, f, 1)',
      'export const literal = (f: () => void) => React[`useEffect`](f)',
      'const { useEffect: picked } = React',
      'const member = React.useEffect',
      "const useIso = typeof window === 'undefined' ? useEffect : useLayoutEffect",
      'export const run = (f: () => void) => [picked(f), member(f), useIso(f)]',
      'export type Handle = ReturnType<typeof setTimeout>',
      "export const idle = typeof requestIdleCallback === 'function'",
      'export const handle: ReturnType<typeof setTimeout> | null = null',
      '',
    ].join('\n'),
  })
  const result = repo.run(['--base', base])
  assert.equal(result.status, 1, result.stdout)
  assert.match(result.stderr, /timer rose from 0 to 3/)
  for (const line of [2, 3, 4])
    assert.match(result.stderr, new RegExp(`frame\\.tsx:${line} `))
  assert.match(result.stderr, /effect rose from 0 to 5/)
  for (const line of [5, 6, 7])
    assert.match(result.stderr, new RegExp(`frame\\.tsx:${line} useEffect`))
  assert.match(result.stderr, /frame\.tsx:8 useLayoutEffect/)
  assert.doesNotMatch(result.stderr, /frame\.tsx:(?:9|1[0-2]) /)
})

test('counts trailing and block comments inside a template script element, not CSS comments', (t) => {
  const repo = repository(t)
  const base = repo.commit('base')
  repo.write({
    'packages/cli/src/preview/page.ts': [
      'export const page = (data: string) => `<style>',
      '  /* the panel stays on top */',
      '</style>',
      '<script>',
      '  render() // the first paint',
      '  /* a block note */',
      '  const state = ${data}// parsed once',
      "  const link = 'https://example.com/a' + \\`//b\\`",
      '</script>`',
      '',
    ].join('\n'),
  })
  const result = repo.run(['--base', base])
  assert.equal(result.status, 1, result.stdout)
  assert.match(result.stderr, /comment rose from 0 to 3/)
  assert.match(result.stderr, /page\.ts:5 "the first paint"/)
  assert.match(result.stderr, /page\.ts:6 "a block note"/)
  assert.match(result.stderr, /page\.ts:7 "parsed once"/)
})

test('skips an untracked symlink to a directory that has a code extension', (t) => {
  const repo = repository(t)
  repo.write({ 'apps/web/app/real/index.ts': 'export {}\n' })
  const base = repo.commit('base')
  symlinkSync('real', join(repo.directory, 'apps/web/app/linked.ts'))
  const result = repo.run(['--base', base])
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /ok \(effect 0 -> 0/)
})
