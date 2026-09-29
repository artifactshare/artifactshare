import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { landed, parseLandedArgs } from './pr-landed.mjs'
import {
  readLedger,
  recordDeferred,
  writeLedgerAtomic,
} from './landing-ledger.mjs'

const head = 'a'.repeat(40)

function ledgerWith(deferred) {
  const path = join(mkdtempSync(join(tmpdir(), 'as-landed-')), 'ledger.json')
  writeLedgerAtomic(
    path,
    recordDeferred(readLedger(path), { pr: 7, head, deferred }),
  )
  return path
}

const sharedGitCommon = mkdtempSync(join(tmpdir(), 'as-landed-git-common-'))
process.on('exit', () =>
  rmSync(sharedGitCommon, { recursive: true, force: true }),
)

function emptyLedger() {
  return join(mkdtempSync(join(tmpdir(), 'as-landed-empty-')), 'ledger.json')
}

// `here` is this checkout's top level, `mainWorktree` the worktree holding
// `main` (null when none), `current` the branch checked out here (defaults to
// `main` when this worktree holds main, else the PR branch), `firstWorktree`
// the main checkout listed first by git; checkout commands move `current` the
// way the real ones would, and `mergedMark` is git's prefix for the merged
// branch line ("+ " when it is checked out in another worktree).
function harness({
  state = 'MERGED',
  branch = 'feat/x',
  here = '/repo',
  mainWorktree = '/repo',
  firstWorktree = mainWorktree ?? here,
  current = mainWorktree === here ? 'main' : branch,
  otherHolder = null,
  prunable = null,
} = {}) {
  const calls = []
  let checkedOut = current
  const common = sharedGitCommon
  const exec = (file, args) => {
    calls.push([file, args])
    if (file === 'gh')
      return JSON.stringify({
        state,
        mergeCommit: { oid: 'c'.repeat(40) },
        headRefName: branch,
      })
    if (args[0] === 'branch' && args[1] === '--merged')
      return `refs/heads/main\nrefs/heads/${branch}\n`
    if (args[0] === 'branch' && args[1] === '--show-current')
      return `${checkedOut}\n`
    if (args[0] === 'rev-parse' && args[1] === '--show-toplevel')
      return `${here}\n`
    if (args[0] === 'rev-parse' && args[1] === '--git-common-dir')
      return `${common}\n`
    if (args[0] === 'worktree' && args[1] === 'list') {
      const entries = []
      if (firstWorktree !== here)
        entries.push(
          `worktree ${firstWorktree}\nHEAD abc\nbranch refs/heads/${firstWorktree === mainWorktree ? 'main' : 'other'}\n`,
        )
      entries.push(
        checkedOut
          ? `worktree ${here}\nHEAD def\nbranch refs/heads/${checkedOut}\n`
          : `worktree ${here}\nHEAD def\ndetached\n`,
      )
      if (otherHolder)
        entries.push(
          `worktree ${otherHolder}\nHEAD ghi\nbranch refs/heads/${branch}\n`,
        )
      if (prunable)
        entries.push(
          `worktree ${prunable}\nHEAD zzz\nbranch refs/heads/main\nprunable gitdir file points to non-existent location\n`,
        )
      return entries.join('\n')
    }
    if (args[0] === 'checkout')
      checkedOut = args[1] === '--detach' ? '' : args[1]
    return ''
  }
  return { calls, exec }
}

test('a PR number is required', () => {
  assert.throws(() => parseLandedArgs([]), /Usage/u)
  assert.deepEqual(parseLandedArgs(['--pr', '7']), { pr: 7, dryRun: false })
  assert.deepEqual(parseLandedArgs(['--', '--pr', '7', '--dry-run']), {
    pr: 7,
    dryRun: true,
  })
  assert.throws(
    () => parseLandedArgs(['--pr', '7', '--disposition', 'issue:filed']),
    /Usage/u,
  )
})

test('deferred findings are released without landing dispositions', async () => {
  const h = harness()
  const path = ledgerWith(['name the select', 'evict snapshots'])
  const result = await landed({
    exec: h.exec,
    parsed: { pr: 7, dryRun: false },
    ledger: path,
  })
  assert.equal(result.releasedDeferred, 2)
  assert.deepEqual(readLedger(path).entries, [])
})

test('landing clears the entry and finishes the local lifecycle', async () => {
  const h = harness()
  const path = ledgerWith(['name the select'])
  const result = await landed({
    exec: h.exec,
    parsed: { pr: 7, dryRun: false },
    ledger: path,
  })
  assert.equal(result.releasedDeferred, 1)
  assert.deepEqual(readLedger(path).entries, [])
  const commands = h.calls.map(([file, args]) => `${file} ${args.join(' ')}`)
  assert.ok(!commands.includes('git checkout main'))
  assert.ok(commands.includes('git pull --ff-only'))
  assert.ok(commands.includes('git branch -D feat/x'))
  assert.ok(result.notes.some((note) => /Deleted branch feat\/x/u.test(note)))
})

test('from a feature worktree it syncs main where it is checked out and parks the worktree', async () => {
  const path = ledgerWith(['name the select'])
  const h = harness({ here: '/repo/feature', mainWorktree: '/repo/main' })
  const result = await landed({
    exec: h.exec,
    parsed: { pr: 7, dryRun: false },
    ledger: path,
  })
  assert.equal(result.exitCode, 0)
  const commands = h.calls.map(([file, args]) => `${file} ${args.join(' ')}`)
  assert.ok(commands.includes('git -C /repo/main pull --ff-only'))
  assert.ok(!commands.includes('git checkout main'))
  assert.ok(commands.includes('git checkout --detach main'))
  assert.ok(commands.includes('git branch -D feat/x'))
  assert.ok(result.notes.some((note) => /Parked this worktree/u.test(note)))
})

test('a feature worktree on another branch is left alone while the merged branch is deleted', async () => {
  const path = ledgerWith(['name the select'])
  const h = harness({
    here: '/repo/feature',
    mainWorktree: '/repo/main',
    current: 'feat/other',
  })
  const result = await landed({
    exec: h.exec,
    parsed: { pr: 7, dryRun: false },
    ledger: path,
  })
  assert.equal(result.exitCode, 0)
  const commands = h.calls.map(([file, args]) => `${file} ${args.join(' ')}`)
  assert.ok(!commands.some((c) => c.startsWith('git checkout')))
  assert.ok(commands.includes('git branch -D feat/x'))
})

test('a closed but unmerged PR does not move the worktree', async () => {
  const path = ledgerWith(['name the select'])
  const h = harness({
    state: 'CLOSED',
    here: '/repo/feature',
    mainWorktree: '/repo/main',
  })
  // Not merged: git lists only main as merged.
  const exec = (file, args) =>
    args[0] === 'branch' && args[1] === '--merged'
      ? 'refs/heads/main\n'
      : h.exec(file, args)
  await landed({
    exec,
    parsed: { pr: 7, dryRun: false },
    ledger: path,
  })
  const commands = h.calls.map(([file, args]) => `${file} ${args.join(' ')}`)
  assert.ok(!commands.includes('git checkout --detach main'))
  assert.ok(!commands.some((c) => c.startsWith('git branch -D')))
})

test('a merged branch is recognised only by its full ref', async () => {
  const path = ledgerWith(['name the select'])
  const h = harness()
  // A tag named like the branch shortens ambiguously; only refs/heads counts.
  const exec = (file, args) =>
    args[0] === 'branch' && args[1] === '--merged'
      ? 'refs/heads/main\nrefs/tags/feat/x\n'
      : h.exec(file, args)
  const result = await landed({
    exec,
    parsed: { pr: 7, dryRun: false },
    ledger: path,
  })
  const commands = h.calls.map(([file, args]) => `${file} ${args.join(' ')}`)
  assert.ok(!commands.some((c) => c.startsWith('git branch -D')))
  assert.ok(result.notes.some((note) => /not merged into main/u.test(note)))
})

test('without a worktree on main it refuses to hijack main into a feature worktree', async () => {
  const path = ledgerWith(['name the select'])
  const h = harness({
    here: '/repo/feature',
    mainWorktree: null,
    firstWorktree: '/repo',
    current: 'feat/x',
  })
  const result = await landed({
    exec: h.exec,
    parsed: { pr: 7, dryRun: false },
    ledger: path,
  })
  assert.equal(result.exitCode, 1)
  assert.match(result.problems[0], /No worktree has main checked out/u)
  const commands = h.calls.map(([file, args]) => `${file} ${args.join(' ')}`)
  assert.ok(!commands.includes('git checkout main'))
})

test('in the main checkout with main not checked out it checks main out here', async () => {
  const path = ledgerWith(['name the select'])
  const h = harness({
    here: '/repo',
    mainWorktree: null,
    firstWorktree: '/repo',
    current: 'feat/x',
  })
  await landed({
    exec: h.exec,
    parsed: { pr: 7, dryRun: false },
    ledger: path,
  })
  const commands = h.calls.map(([file, args]) => `${file} ${args.join(' ')}`)
  assert.ok(commands.includes('git checkout main'))
  assert.ok(commands.includes('git pull --ff-only'))
})

test('a PR with no record releases nothing and still succeeds', async () => {
  const h = harness()
  const result = await landed({
    exec: h.exec,
    parsed: { pr: 99, dryRun: false },
    ledger: ledgerWith(['name the select']),
  })
  assert.equal(result.releasedDeferred, 0)
})

test('a change that deferred nothing still finishes its lifecycle', async () => {
  const h = harness()
  const result = await landed({
    exec: h.exec,
    parsed: { pr: 7, dryRun: false },
    ledger: emptyLedger(),
  })
  assert.equal(result.releasedDeferred, 0)
  const commands = h.calls.map(([file, args]) => `${file} ${args.join(' ')}`)
  assert.ok(commands.includes('git pull --ff-only'))
  assert.ok(commands.includes('git branch -D feat/x'))
})

test('a PR closed without merging can still release its deferrals', async () => {
  const h = harness({ state: 'CLOSED' })
  const path = ledgerWith(['name the select'])
  const result = await landed({
    exec: h.exec,
    parsed: { pr: 7, dryRun: false },
    ledger: path,
  })
  assert.equal(result.state, 'CLOSED')
  assert.deepEqual(readLedger(path).entries, [])
})

test('dry run verifies the PR state without releasing or cleaning up', async () => {
  const h = harness()
  const path = ledgerWith(['name the select'])
  const result = await landed({
    exec: h.exec,
    parsed: { pr: 7, dryRun: true },
    ledger: path,
  })
  assert.equal(result.releasedDeferred, 1)
  assert.equal(result.dryRun, true)
  assert.equal(
    h.calls.some(([file]) => file === 'git'),
    false,
  )
  assert.equal(readLedger(path).entries.length, 1)
})

test('an unlanded PR is refused', async () => {
  const h = harness({ state: 'OPEN' })
  await assert.rejects(
    () =>
      landed({
        exec: h.exec,
        parsed: { pr: 7, dryRun: false },
        ledger: ledgerWith(['name the select']),
      }),
    /is OPEN; finish it once it has landed/u,
  )
})

test('local cleanup failure does not leave the deferral blocking every publish', async () => {
  // A linked worktree already on main, a dirty tree, or a non-ff pull must not
  // strand the entry: releasing it is part of landing; sync is convenience.
  const path = ledgerWith(['name the select'])
  const exec = (file, args) => {
    if (file === 'gh')
      return JSON.stringify({ state: 'MERGED', headRefName: 'feat/x' })
    if (args[0] === 'checkout') throw new Error('already checked out elsewhere')
    return ''
  }
  const result = await landed({
    exec,
    parsed: { pr: 7, dryRun: false },
    ledger: path,
  })
  assert.deepEqual(readLedger(path).entries, [])
  assert.equal(result.problems.length, 1)
  // An unfinished cleanup must not read as a finished lifecycle.
  assert.equal(result.exitCode, 1)
})

test('a rerun after cleanup succeeds without a ledger entry', async () => {
  const h = harness()
  const result = await landed({
    exec: h.exec,
    parsed: { pr: 7, dryRun: false },
    ledger: emptyLedger(),
  })
  assert.equal(result.releasedDeferred, 0)
  assert.equal(result.exitCode, 0)
})

test('a merged branch checked out in another worktree is left with a note', async () => {
  const path = ledgerWith(['name the select'])
  const h = harness({
    here: '/repo/main',
    mainWorktree: '/repo/main',
    current: 'main',
    otherHolder: '/repo/feature',
  })
  const result = await landed({
    exec: h.exec,
    parsed: { pr: 7, dryRun: false },
    ledger: path,
  })
  assert.equal(result.exitCode, 0)
  const commands = h.calls.map(([file, args]) => `${file} ${args.join(' ')}`)
  assert.ok(!commands.some((c) => c.startsWith('git branch -D')))
  assert.ok(
    result.notes.some((note) => /checked out in \/repo\/feature/u.test(note)),
  )
})

test('a prunable worktree registration holding main is ignored', async () => {
  const path = ledgerWith(['name the select'])
  const h = harness({
    here: '/repo',
    mainWorktree: '/repo',
    current: 'main',
    prunable: '/gone/old',
  })
  const result = await landed({
    exec: h.exec,
    parsed: { pr: 7, dryRun: false },
    ledger: path,
  })
  assert.equal(result.exitCode, 0)
  const commands = h.calls.map(([file, args]) => `${file} ${args.join(' ')}`)
  assert.ok(!commands.some((c) => c.includes('/gone/old')))
  assert.ok(commands.includes('git pull --ff-only'))
})

test('landing waits for Ready, preserves its write, and releases before git cleanup', async () => {
  const ledger = ledgerWith(['old finding'])
  const h = harness()
  const gate = Promise.withResolvers()
  let released = false
  const logs = []
  const pending = landed({
    ledger,
    parsed: { pr: 7, dryRun: false },
    log: (line) => logs.push(line),
    acquireLock: (path, options) => {
      assert.equal(path, `${ledger}.lock`)
      assert.equal(options.acquireTimeoutMs, 600_000)
      options.onContention()
      return gate.promise
    },
    exec: (file, args) => {
      assert.equal(released, file === 'git')
      return h.exec(file, args)
    },
  })
  assert.deepEqual(h.calls, [])
  writeLedgerAtomic(
    ledger,
    recordDeferred(readLedger(ledger), {
      pr: 8,
      head,
      deferred: ['Ready finding'],
    }),
  )
  gate.resolve(() => {
    released = true
  })
  await pending
  assert.deepEqual(
    readLedger(ledger).entries.map((e) => e.pr),
    [8],
  )
  assert.equal(logs.length, 1)
  assert.ok(logs[0].includes(`${ledger}.lock`))
})

for (const mode of ['dry', 'open', 'timeout', 'immediate']) {
  test(`landing lock: ${mode}`, async () => {
    const ledger = ledgerWith(['finding'])
    const before = readLedger(ledger)
    const h = harness({ state: mode === 'open' ? 'OPEN' : 'MERGED' })
    const logs = []
    let released = false
    const operation = landed({
      ledger,
      parsed: { pr: 7, dryRun: mode === 'dry' },
      log: (line) => logs.push(line),
      exec: h.exec,
      acquireLock: (path, options) => {
        assert.equal(path, `${ledger}.lock`)
        assert.equal(options.wait, true)
        assert.equal(options.acquireTimeoutMs, 600_000)
        if (mode === 'timeout') {
          options.onContention()
          throw Object.assign(new Error('timeout'), { code: 'LOCK_TIMEOUT' })
        }
        return () => {
          released = true
        }
      },
    })
    if (mode === 'timeout') {
      await assert.rejects(
        operation,
        (error) =>
          error.message.includes(`${ledger}.lock`) &&
          error.message.includes('lsof '),
      )
      assert.deepEqual(h.calls, [])
      assert.equal(logs.length, 1)
    } else {
      if (mode === 'open') await assert.rejects(operation, /is OPEN/u)
      else await operation
      assert.equal(released, true)
      assert.deepEqual(logs, [])
    }
    if (mode !== 'immediate') assert.deepEqual(readLedger(ledger), before)
    if (mode === 'dry') assert.ok(h.calls.every(([file]) => file === 'gh'))
  })
}

test('dry landing reads only after acquisition and releases its consistent snapshot', async () => {
  const ledger = emptyLedger()
  const gate = Promise.withResolvers()
  let released = false
  const pending = landed({
    ledger,
    parsed: { pr: 7, dryRun: true },
    exec: harness().exec,
    acquireLock: () => gate.promise,
  })
  writeLedgerAtomic(
    ledger,
    recordDeferred(readLedger(ledger), {
      pr: 7,
      head,
      deferred: ['written while waiting'],
    }),
  )
  gate.resolve(() => {
    released = true
  })
  const result = await pending
  assert.equal(result.releasedDeferred, 1)
  assert.equal(released, true)
  assert.equal(readLedger(ledger).entries.length, 1)
})

for (const state of ['MERGED', 'OPEN']) {
  test(`landing preserves ${state} outcome when lock release rejects`, async () => {
    const ledger = ledgerWith(['finding'])
    const before = readLedger(ledger)
    const h = harness({ state })
    let releaseAttempted = false
    const pending = landed({
      ledger,
      parsed: { pr: 7, dryRun: false },
      exec: (file, args) => {
        if (file === 'git') assert.equal(releaseAttempted, true)
        return h.exec(file, args)
      },
      acquireLock: () => () => {
        releaseAttempted = true
        return Promise.reject(new Error('synthetic release failure'))
      },
    })
    if (state === 'OPEN') {
      await assert.rejects(
        pending,
        /^Error: PR #7 is OPEN;.*\nAdditionally, Landing-lock release failed: synthetic release failure$/u,
      )
      assert.deepEqual(readLedger(ledger), before)
      assert.ok(h.calls.every(([file]) => file === 'gh'))
    } else {
      const result = await pending
      assert.equal(result.exitCode, 1)
      assert.equal(result.releasedDeferred, 1)
      assert.deepEqual(readLedger(ledger).entries, [])
      assert.deepEqual(result.problems, [
        'Landing-lock release failed: synthetic release failure',
      ])
      assert.ok(result.notes.includes('Fast-forwarded main here'))
      assert.ok(result.notes.includes('Deleted branch feat/x'))
    }
    assert.equal(releaseAttempted, true)
  })
}
