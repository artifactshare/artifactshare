import { rmSync, writeFileSync } from 'node:fs'
import { tmpdir as osTmpdir } from 'node:os'
import { join as joinPath } from 'node:path'
import {
  readLedger as readLandingLedger,
  recordDeferred as recordLandingDeferred,
  writeLedgerAtomic as writeLandingLedger,
} from './landing-ledger.mjs'
import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { parsePublishArgs, publishPullRequest } from './pr-publish.mjs'

const tempLedger = () =>
  joinPath(osTmpdir(), `pr-publish-ledger-${randomUUID()}.json`)

function harness({
  prs = [],
  title = 'Public title',
  body = 'Public body',
} = {}) {
  const calls = []
  const exec = (file, args) => {
    calls.push([file, args])
    if (file === 'git' && args[0] === 'branch') return 'feature/x\n'
    if (file === 'gh' && args[1] === 'list') return JSON.stringify(prs)
    return ''
  }
  // One ledger per harness; publish never writes it, so no cleanup is needed.
  const ledger = tempLedger()
  return {
    calls,
    ledger,
    run: (options = {}) =>
      publishPullRequest({
        bodyFile: 'body.md',
        title,
        readFile: () => body,
        exec,
        ...options,
        // Never the checkout's own ledger: an undischarged deferral from a
        // real PR would fail these tests in every worktree of the checkout.
        ledger: options.ledger ?? ledger,
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
  const h = harness({
    prs: [{ number: 3, baseRefName: 'main', headRefName: 'feature/x' }],
  })
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
        ledger: tempLedger(),
        exec: () => {
          called = true
        },
      }),
    /forbidden metadata/u,
  )
  assert.equal(called, false)
})

test('requires a topic branch and main bases for every listed PR', () => {
  assert.throws(
    () =>
      publishPullRequest({
        bodyFile: 'body.md',
        title: 'Public title',
        readFile: () => 'Public body',
        ledger: tempLedger(),
        exec: (file, args) => {
          if (file === 'git' && args[0] === 'branch') return 'main\n'
          return ''
        },
      }),
    /topic branch/u,
  )
  assert.throws(
    () =>
      harness({
        prs: [{ number: 3, baseRefName: 'release', headRefName: 'feature/x' }],
      }).run(),
    /base must be main/u,
  )
  assert.throws(
    () =>
      harness({
        prs: [
          { number: 2, baseRefName: 'release', headRefName: 'other' },
          { number: 3, baseRefName: 'main', headRefName: 'feature/x' },
        ],
      }).run(),
    /pull request #2 base must be main/u,
  )
})

test('accepts up to three open PRs when this branch already owns one', () => {
  for (let count = 1; count <= 3; count += 1) {
    const prs = [
      { number: 10, baseRefName: 'main', headRefName: 'feature/x' },
      { number: 11, baseRefName: 'main', headRefName: 'feature/y' },
      { number: 12, baseRefName: 'main', headRefName: 'feature/z' },
    ].slice(0, count)
    const h = harness({ prs })
    assert.deepEqual(h.run(), { mode: 'update', number: 10 })
    assert.deepEqual(h.calls.at(-1)[1].slice(0, 3), ['pr', 'edit', '10'])
  }
})

test('does not mistake other branches for this branch and may create through the third PR', () => {
  const available = [
    { number: 11, baseRefName: 'main', headRefName: 'feature/y' },
    { number: 12, baseRefName: 'main', headRefName: 'feature/z' },
  ]
  for (let count = 0; count <= 2; count += 1) {
    const h = harness({ prs: available.slice(0, count) })
    assert.deepEqual(h.run(), { mode: 'create' })
    assert.deepEqual(h.calls.at(-2), [
      'git',
      ['push', '--set-upstream', 'origin', 'feature/x'],
    ])
    assert.deepEqual(h.calls.at(-1)[1].slice(0, 2), ['pr', 'create'])
  }
})

test('rejects creating a fourth PR while preserving the other branch identities', () => {
  const h = harness({
    prs: [
      { number: 11, baseRefName: 'main', headRefName: 'feature/y' },
      { number: 12, baseRefName: 'main', headRefName: 'feature/z' },
      { number: 13, baseRefName: 'main', headRefName: 'feature/w' },
    ],
  })
  assert.throws(() => h.run(), /three-open-PR limit/u)
  assert.equal(
    h.calls.some(
      ([file, args]) =>
        (file === 'git' && args[0] === 'push') ||
        (file === 'gh' && ['create', 'edit'].includes(args[1])),
    ),
    false,
  )
})

test('rejects an already-invalid fourth open PR before push, create, or edit', () => {
  const h = harness({
    prs: [
      { number: 10, baseRefName: 'main', headRefName: 'feature/x' },
      { number: 11, baseRefName: 'main', headRefName: 'feature/y' },
      { number: 12, baseRefName: 'main', headRefName: 'feature/z' },
      { number: 13, baseRefName: 'main', headRefName: 'feature/w' },
    ],
  })
  assert.throws(() => h.run(), /more than three/u)
  assert.equal(
    h.calls.some(
      ([file, args]) =>
        (file === 'git' && args[0] === 'push') ||
        (file === 'gh' && ['create', 'edit'].includes(args[1])),
    ),
    false,
  )
})

test('malformed GitHub PR list responses fail closed before any write', () => {
  const malformed = [
    {},
    [null],
    [{ number: 1, baseRefName: 'main' }],
    [{ number: 1, headRefName: 'feature/x' }],
    [{ number: '1', baseRefName: 'main', headRefName: 'feature/x' }],
    [
      { number: 1, baseRefName: 'main', headRefName: 'feature/x' },
      { number: 1, baseRefName: 'main', headRefName: 'feature/y' },
    ],
  ]
  for (const response of malformed) {
    const h = harness({ prs: response })
    assert.throws(() => h.run(), /GitHub PR query failed/u)
    assert.equal(
      h.calls.some(
        ([file, args]) =>
          (file === 'git' && args[0] === 'push') ||
          (file === 'gh' && ['create', 'edit'].includes(args[1])),
      ),
      false,
    )
  }
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

test('publishing refuses while a previous change has undischarged deferrals', (t) => {
  const path = tempLedger()
  t.after(() => rmSync(path, { force: true }))
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

test('a change may update its own body while its deferrals are still pending', (t) => {
  const path = tempLedger()
  t.after(() => rmSync(path, { force: true }))
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

test('a corrupt ledger refuses the publish rather than reading as empty', (t) => {
  const path = tempLedger()
  t.after(() => rmSync(path, { force: true }))
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
