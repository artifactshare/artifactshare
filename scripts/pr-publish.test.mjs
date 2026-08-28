import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir as osTmpdir } from 'node:os'
import { join as joinPath } from 'node:path'
import {
  readLedger as readLandingLedger,
  recordDeferred as recordLandingDeferred,
  writeLedgerAtomic as writeLandingLedger,
} from './landing-ledger.mjs'
import assert from 'node:assert/strict'
import test from 'node:test'
import { parsePublishArgs, publishPullRequest } from './pr-publish.mjs'

function harness({
  pr = null,
  title = 'Public title',
  body = 'Public body',
} = {}) {
  const calls = []
  const exec = (file, args) => {
    calls.push([file, args])
    if (file === 'git' && args[0] === 'branch') return 'feature/x\n'
    if (file === 'gh' && args[1] === 'list')
      return JSON.stringify(pr ? [{ headRefName: 'feature/x', ...pr }] : [])
    return ''
  }
  return {
    calls,
    run: (options = {}) =>
      publishPullRequest({
        bodyFile: 'body.md',
        title,
        readFile: () => body,
        exec,
        ...options,
      }),
  }
}

test('checks public metadata then pushes and creates a Draft', () => {
  const h = harness()
  assert.deepEqual(h.run(), { mode: 'create' })
  assert.deepEqual(h.calls.at(-2), [
    'git',
    ['push', '--set-upstream', 'origin', 'feature/x'],
  ])
  assert.deepEqual(h.calls.at(-1)[0], 'gh')
  assert.deepEqual(h.calls.at(-1)[1].slice(0, 5), [
    'pr',
    'create',
    '--draft',
    '--base',
    'main',
  ])
})

test('updates an existing branch PR without lifecycle snapshots', () => {
  const h = harness({ pr: { number: 3, baseRefName: 'main' } })
  assert.deepEqual(h.run(), { mode: 'update', number: 3 })
  assert.equal(
    h.calls.some(([file, args]) => file === 'git' && args[0] === 'fetch'),
    false,
  )
  assert.equal(
    h.calls.some(([file, args]) => file === 'git' && args[0] === 'push'),
    false,
  )
  assert.deepEqual(h.calls.at(-1)[1].slice(0, 3), ['pr', 'edit', '3'])
})

test('rejects private metadata before any command or remote write', () => {
  let called = false
  assert.throws(
    () =>
      publishPullRequest({
        bodyFile: 'body.md',
        title: 'fix #1552',
        readFile: () => 'Public body',
        exec: () => {
          called = true
        },
      }),
    /forbidden metadata/u,
  )
  assert.equal(called, false)
})

test('requires a topic branch, main base, and no other open PR', () => {
  assert.throws(
    () =>
      publishPullRequest({
        bodyFile: 'body.md',
        title: 'Public title',
        readFile: () => 'Public body',
        exec: (file, args) => {
          if (file === 'git' && args[0] === 'branch') return 'main\n'
          return ''
        },
      }),
    /topic branch/u,
  )
  assert.throws(
    () => harness({ pr: { number: 3, baseRefName: 'release' } }).run(),
    /base must be main/u,
  )
  assert.throws(
    () =>
      harness({
        pr: { number: 3, baseRefName: 'main', headRefName: 'other' },
      }).run(),
    /another branch/u,
  )
})

test('parses the small publication option set', () => {
  assert.deepEqual(
    parsePublishArgs([
      '--',
      '--body-file',
      'body.md',
      '--title',
      'Title',
      '--dry-run',
    ]),
    { bodyFile: 'body.md', title: 'Title', dryRun: true, help: false },
  )
  assert.throws(() => parsePublishArgs(['--unknown']), /unknown argument/u)
})

test('publishing refuses while a previous change has undischarged deferrals', () => {
  const path = joinPath(
    mkdtempSync(joinPath(osTmpdir(), 'as-publish-ledger-')),
    'ledger.json',
  )
  writeLandingLedger(
    path,
    recordLandingDeferred(readLandingLedger(path), {
      pr: 41,
      head: 'a'.repeat(40),
      deferred: ['name the select for screen readers'],
    }),
  )
  assert.throws(
    () =>
      publishPullRequest({
        bodyFile: 'body.md',
        title: 'Next change',
        exec: (file) => (file === 'git' ? 'feat/next' : '[]'),
        readFile: () => 'body',
        ledger: path,
      }),
    (error) => {
      assert.match(error.message, /deferred review findings/u)
      assert.match(error.message, /PR #41/u)
      assert.match(error.message, /name the select for screen readers/u)
      assert.match(error.message, /pnpm pr:landed/u)
      return true
    },
  )
})

test('a change may update its own body while its deferrals are still pending', () => {
  const path = joinPath(
    mkdtempSync(joinPath(osTmpdir(), 'as-publish-own-')),
    'ledger.json',
  )
  writeLandingLedger(
    path,
    recordLandingDeferred(readLandingLedger(path), {
      pr: 52,
      head: 'a'.repeat(40),
      deferred: ['name the select for screen readers'],
    }),
  )
  const result = publishPullRequest({
    bodyFile: 'body.md',
    title: 'Same change, better body',
    dryRun: true,
    readFile: () => 'body',
    exec: (file, args) => {
      if (file === 'git') return 'feat/current'
      return JSON.stringify([
        { number: 52, baseRefName: 'main', headRefName: 'feat/current' },
      ])
    },
    ledger: path,
  })
  assert.deepEqual(result, { mode: 'update', number: 52, dryRun: true })
})

test('a corrupt ledger refuses the publish rather than reading as empty', () => {
  const path = joinPath(
    mkdtempSync(joinPath(osTmpdir(), 'as-publish-corrupt-')),
    'ledger.json',
  )
  writeFileSync(path, '{ truncated')
  assert.throws(
    () =>
      publishPullRequest({
        bodyFile: 'body.md',
        title: 'Next change',
        exec: (file) => (file === 'git' ? 'feat/next' : '[]'),
        readFile: () => 'body',
        ledger: path,
      }),
    /could not be read/u,
  )
})
