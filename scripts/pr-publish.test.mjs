import { rmSync, writeFileSync, readFileSync } from 'node:fs'
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
  const normalizedPrs = Array.isArray(prs)
    ? prs.map((row) =>
        row && typeof row === 'object' && !Array.isArray(row)
          ? { isCrossRepository: false, ...row }
          : row,
      )
    : prs
  const exec = (file, args) => {
    calls.push([file, args])
    if (file === 'git' && args[0] === 'branch') return 'feature/x\n'
    if (file === 'git' && args.join(' ') === 'rev-parse --git-common-dir')
      return '/repo/.git\n'
    if (file === 'gh' && args[1] === 'list')
      return JSON.stringify(normalizedPrs)
    return ''
  }
  return {
    calls,
    runExec: exec,
    run: (options = {}) =>
      publishPullRequest({
        bodyFile: 'body.md',
        title,
        readFile: () => body,
        exec,
        acquireLock: () => Promise.resolve(() => {}),
        ...options,
      }),
  }
}

test('checks public metadata then pushes and creates a Draft', async () => {
  const h = harness()
  assert.deepEqual(await h.run(), { mode: 'create' })
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

test('updates an existing branch PR without lifecycle snapshots', async () => {
  const h = harness({
    prs: [{ number: 3, baseRefName: 'main', headRefName: 'feature/x' }],
  })
  assert.deepEqual(await h.run(), { mode: 'update', number: 3 })
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

test('rejects private metadata before any command or remote write', async () => {
  let called = false
  await assert.rejects(
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

test('requires a topic branch and main bases for every listed PR', async () => {
  await assert.rejects(
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
  await assert.rejects(
    harness({
      prs: [{ number: 3, baseRefName: 'release', headRefName: 'feature/x' }],
    }).run(),
    /base must be main/u,
  )
  await assert.rejects(
    harness({
      prs: [
        { number: 2, baseRefName: 'release', headRefName: 'other' },
        { number: 3, baseRefName: 'main', headRefName: 'feature/x' },
      ],
    }).run(),
    /pull request #2 base must be main/u,
  )
})

test('accepts up to three open PRs when this branch already owns one', async () => {
  for (let count = 1; count <= 3; count += 1) {
    const prs = [
      { number: 10, baseRefName: 'main', headRefName: 'feature/x' },
      { number: 11, baseRefName: 'main', headRefName: 'feature/y' },
      { number: 12, baseRefName: 'main', headRefName: 'feature/z' },
    ].slice(0, count)
    const h = harness({ prs })
    assert.deepEqual(await h.run(), { mode: 'update', number: 10 })
    assert.deepEqual(h.calls.at(-1)[1].slice(0, 3), ['pr', 'edit', '10'])
  }
})

test('does not mistake other branches for this branch and may create through the third PR', async () => {
  const available = [
    { number: 11, baseRefName: 'main', headRefName: 'feature/y' },
    { number: 12, baseRefName: 'main', headRefName: 'feature/z' },
  ]
  for (let count = 0; count <= 2; count += 1) {
    const h = harness({ prs: available.slice(0, count) })
    assert.deepEqual(await h.run(), { mode: 'create' })
    assert.deepEqual(h.calls.at(-2), [
      'git',
      ['push', '--set-upstream', 'origin', 'feature/x'],
    ])
    assert.deepEqual(h.calls.at(-1)[1].slice(0, 2), ['pr', 'create'])
  }
})

test('rejects creating a fourth PR while preserving the other branch identities', async () => {
  const h = harness({
    prs: [
      { number: 11, baseRefName: 'main', headRefName: 'feature/y' },
      { number: 12, baseRefName: 'main', headRefName: 'feature/z' },
      { number: 13, baseRefName: 'main', headRefName: 'feature/w' },
    ],
  })
  await assert.rejects(h.run(), /three-open-PR limit/u)
  assert.equal(
    h.calls.some(
      ([file, args]) =>
        (file === 'git' && args[0] === 'push') ||
        (file === 'gh' && ['create', 'edit'].includes(args[1])),
    ),
    false,
  )
})

test('rejects an already-invalid fourth open PR before push, create, or edit', async () => {
  const h = harness({
    prs: [
      { number: 10, baseRefName: 'main', headRefName: 'feature/x' },
      { number: 11, baseRefName: 'main', headRefName: 'feature/y' },
      { number: 12, baseRefName: 'main', headRefName: 'feature/z' },
      { number: 13, baseRefName: 'main', headRefName: 'feature/w' },
    ],
  })
  await assert.rejects(h.run(), /more than three/u)
  assert.equal(
    h.calls.some(
      ([file, args]) =>
        (file === 'git' && args[0] === 'push') ||
        (file === 'gh' && ['create', 'edit'].includes(args[1])),
    ),
    false,
  )
})

test('malformed GitHub PR list responses fail closed before any write', async () => {
  const malformed = [
    {},
    [null],
    [{ number: 1, baseRefName: 'main' }],
    [{ number: 1, headRefName: 'feature/x' }],
    [{ number: '1', baseRefName: 'main', headRefName: 'feature/x' }],
    [
      {
        number: 1,
        baseRefName: 'main',
        headRefName: 'feature/x',
        isCrossRepository: undefined,
      },
    ],
    [
      { number: 1, baseRefName: 'main', headRefName: 'feature/x' },
      { number: 1, baseRefName: 'main', headRefName: 'feature/y' },
    ],
  ]
  for (const response of malformed) {
    const h = harness({ prs: response })
    await assert.rejects(h.run(), /GitHub PR query failed/u)
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

test('ignores a fork PR whose branch name collides with the local branch', async () => {
  const h = harness({
    prs: [
      {
        number: 20,
        baseRefName: 'main',
        headRefName: 'feature/x',
        isCrossRepository: true,
      },
      { number: 21, baseRefName: 'main', headRefName: 'feature/y' },
    ],
  })
  assert.deepEqual(await h.run(), { mode: 'create' })
  assert.equal(
    h.calls.some(
      ([file, args]) => file === 'gh' && args[1] === 'edit' && args[2] === '20',
    ),
    false,
  )
  assert.equal(
    h.calls
      .filter(([file, args]) => file === 'gh' && args[1] === 'list')
      .every(([, args]) => args.at(-1).includes('isCrossRepository')),
    true,
  )
})

test('releases the publish lock after success and operation failure', async () => {
  for (const failCreate of [false, true]) {
    const events = []
    const h = harness()
    const exec = (file, args, options) => {
      if (file === 'gh' && args[1] === 'list') {
        events.push('slot-snapshot')
      }
      if (failCreate && file === 'gh' && args[1] === 'create') {
        events.push('operation-failed')
        throw new Error('create failed')
      }
      return h.runExec(file, args, options)
    }
    const run = h.run({
      exec,
      acquireLock: (path) => {
        assert.equal(path, '/repo/.git/artifactshare/pr-publish.lock')
        events.push('acquired')
        return Promise.resolve(() => events.push('released'))
      },
    })
    if (failCreate) await assert.rejects(run, /create failed/u)
    else assert.deepEqual(await run, { mode: 'create' })
    assert.deepEqual(
      events,
      failCreate
        ? ['acquired', 'slot-snapshot', 'operation-failed', 'released']
        : ['acquired', 'slot-snapshot', 'released'],
    )
  }
})

test('a publish-lock failure performs no push, create, or edit', async () => {
  const h = harness()
  await assert.rejects(
    h.run({
      acquireLock: () => Promise.reject(new Error('lock unavailable')),
    }),
    /lock unavailable/u,
  )
  assert.equal(
    h.calls.some(
      ([file, args]) =>
        (file === 'git' && args[0] === 'push') ||
        (file === 'gh' && ['create', 'edit'].includes(args[1])),
    ),
    false,
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

test('publishing ignores outstanding deferrals without looking up the current PR', async (t) => {
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
  const before = readFileSync(path, 'utf8')
  const h = harness()
  const result = await publishPullRequest({
    bodyFile: 'body.md',
    title: 'Next change',
    readFile: () => 'body',
    exec: h.runExec,
    acquireLock: () => Promise.resolve(() => {}),
    get ledger() {
      throw new Error('publish must not access the ledger option')
    },
  })
  assert.deepEqual(result, { mode: 'create' })
  assert.equal(readFileSync(path, 'utf8'), before)
  assert.deepEqual(
    h.calls
      .filter(([file, args]) => file === 'gh' && args[1] === 'list')
      .map(([, args]) => args.at(-1)),
    ['number,baseRefName,headRefName,isCrossRepository'],
  )
})

test('a change may update its own body while its deferrals are still pending', async (t) => {
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
  const result = await publishPullRequest({
    bodyFile: 'body.md',
    title: 'Same change, better body',
    dryRun: true,
    readFile: () => 'body',
    exec: (file, args) => {
      if (file === 'git') return 'feat/current'
      return JSON.stringify([
        {
          number: 51,
          baseRefName: 'main',
          headRefName: 'feat/current',
          isCrossRepository: true,
        },
        {
          number: 52,
          baseRefName: 'main',
          headRefName: 'feat/current',
          isCrossRepository: false,
        },
      ])
    },
    acquireLock: () => Promise.resolve(() => {}),
  })
  assert.deepEqual(result, { mode: 'update', number: 52, dryRun: true })
})

test('publication succeeds with a corrupt ledger without reading it', async (t) => {
  const path = tempLedger()
  t.after(() => rmSync(path, { force: true }))
  writeFileSync(path, '{ truncated')
  const result = await publishPullRequest({
    bodyFile: 'body.md',
    title: 'Next change',
    exec: (file) => (file === 'git' ? 'feat/next' : '[]'),
    readFile: () => 'body',
    acquireLock: () => Promise.resolve(() => {}),
    get ledger() {
      throw new Error('publish must not access the ledger option')
    },
  })
  assert.deepEqual(result, { mode: 'create' })
  assert.equal(readFileSync(path, 'utf8'), '{ truncated')
})
