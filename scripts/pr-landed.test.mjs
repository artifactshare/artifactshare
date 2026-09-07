import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { landed, parseDisposition, parseLandedArgs } from './pr-landed.mjs'
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
  mergedMark = '',
} = {}) {
  const calls = []
  let checkedOut = current
  const common = mkdtempSync(join(tmpdir(), 'as-landed-git-common-'))
  const exec = (file, args) => {
    calls.push([file, args])
    if (file === 'gh')
      return JSON.stringify({
        state,
        mergeCommit: { oid: 'c'.repeat(40) },
        headRefName: branch,
      })
    if (args[0] === 'branch' && args[1] === '--merged')
      return `  main\n${mergedMark}${branch}\n`
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
        `worktree ${here}\nHEAD def\nbranch refs/heads/${checkedOut || 'x'}\n`,
      )
      return entries.join('\n')
    }
    if (args[0] === 'checkout')
      checkedOut = args[1] === '--detach' ? '' : args[1]
    return ''
  }
  return { calls, exec }
}

test('a disposition must name a kind and a note', () => {
  assert.deepEqual(parseDisposition('issue:filed as #1666'), {
    kind: 'issue',
    note: 'filed as #1666',
  })
  assert.throws(() => parseDisposition('issue'), /kind:note/u)
  assert.throws(() => parseDisposition('issue:'), /needs a note/u)
  assert.throws(() => parseDisposition('later:next time'), /must be issue/u)
})

test('a PR number is required', () => {
  assert.throws(() => parseLandedArgs([]), /Usage/u)
  assert.deepEqual(parseLandedArgs(['--pr', '7']).pr, 7)
})

test('every deferred finding needs its own disposition', () => {
  const h = harness()
  assert.throws(
    () =>
      landed({
        exec: h.exec,
        parsed: { pr: 7, dispositions: ['issue:filed'], dryRun: false },
        ledger: ledgerWith(['name the select', 'evict snapshots']),
      }),
    /deferred 2 finding\(s\); 1 disposition\(s\) given/u,
  )
})

test('discharging clears the entry and finishes the local lifecycle', () => {
  const h = harness()
  const path = ledgerWith(['name the select'])
  const result = landed({
    exec: h.exec,
    parsed: { pr: 7, dispositions: ['issue:filed as #1666'], dryRun: false },
    ledger: path,
  })
  assert.equal(result.discharged.length, 1)
  assert.deepEqual(readLedger(path).entries, [])
  const commands = h.calls.map(([file, args]) => `${file} ${args.join(' ')}`)
  assert.ok(!commands.includes('git checkout main'))
  assert.ok(commands.includes('git pull --ff-only'))
  assert.ok(commands.includes('git branch -D feat/x'))
  assert.ok(result.notes.some((note) => /Deleted branch feat\/x/u.test(note)))
})

test('from a feature worktree it syncs main where it is checked out and parks the worktree', () => {
  const path = ledgerWith(['name the select'])
  const h = harness({ here: '/repo/feature', mainWorktree: '/repo/main' })
  const result = landed({
    exec: h.exec,
    parsed: { pr: 7, dispositions: ['issue:filed as #1666'], dryRun: false },
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

test('a feature worktree on another branch is left alone while the merged branch is deleted', () => {
  const path = ledgerWith(['name the select'])
  const h = harness({
    here: '/repo/feature',
    mainWorktree: '/repo/main',
    current: 'feat/other',
    mergedMark: '+ ',
  })
  const result = landed({
    exec: h.exec,
    parsed: { pr: 7, dispositions: ['issue:filed as #1666'], dryRun: false },
    ledger: path,
  })
  assert.equal(result.exitCode, 0)
  const commands = h.calls.map(([file, args]) => `${file} ${args.join(' ')}`)
  assert.ok(!commands.some((c) => c.startsWith('git checkout')))
  assert.ok(commands.includes('git branch -D feat/x'))
})

test('a closed but unmerged PR does not move the worktree', () => {
  const path = ledgerWith(['name the select'])
  const h = harness({
    state: 'CLOSED',
    here: '/repo/feature',
    mainWorktree: '/repo/main',
  })
  // Not merged: git lists only main as merged.
  const exec = (file, args) =>
    args[0] === 'branch' && args[1] === '--merged'
      ? '  main\n'
      : h.exec(file, args)
  landed({
    exec,
    parsed: { pr: 7, dispositions: ['issue:filed as #1666'], dryRun: false },
    ledger: path,
  })
  const commands = h.calls.map(([file, args]) => `${file} ${args.join(' ')}`)
  assert.ok(!commands.includes('git checkout --detach main'))
  assert.ok(!commands.some((c) => c.startsWith('git branch -D')))
})

test('without a worktree on main it refuses to hijack main into a feature worktree', () => {
  const path = ledgerWith(['name the select'])
  const h = harness({
    here: '/repo/feature',
    mainWorktree: null,
    firstWorktree: '/repo',
    current: 'feat/x',
  })
  const result = landed({
    exec: h.exec,
    parsed: { pr: 7, dispositions: ['issue:filed as #1666'], dryRun: false },
    ledger: path,
  })
  assert.equal(result.exitCode, 1)
  assert.match(result.problems[0], /No worktree has main checked out/u)
  const commands = h.calls.map(([file, args]) => `${file} ${args.join(' ')}`)
  assert.ok(!commands.includes('git checkout main'))
})

test('in the main checkout with main not checked out it checks main out here', () => {
  const path = ledgerWith(['name the select'])
  const h = harness({
    here: '/repo',
    mainWorktree: null,
    firstWorktree: '/repo',
    current: 'feat/x',
  })
  landed({
    exec: h.exec,
    parsed: { pr: 7, dispositions: ['issue:filed as #1666'], dryRun: false },
    ledger: path,
  })
  const commands = h.calls.map(([file, args]) => `${file} ${args.join(' ')}`)
  assert.ok(commands.includes('git checkout main'))
  assert.ok(commands.includes('git pull --ff-only'))
})

test('a PR with no record discharges nothing and still succeeds', () => {
  const h = harness()
  const result = landed({
    exec: h.exec,
    parsed: { pr: 99, dispositions: [], dryRun: false },
    ledger: ledgerWith(['name the select']),
  })
  assert.deepEqual(result.discharged, [])
})

test('a change that deferred nothing still finishes its lifecycle', () => {
  const h = harness()
  const result = landed({
    exec: h.exec,
    parsed: { pr: 7, dispositions: [], dryRun: false },
    ledger: emptyLedger(),
  })
  assert.deepEqual(result.discharged, [])
  const commands = h.calls.map(([file, args]) => `${file} ${args.join(' ')}`)
  assert.ok(commands.includes('git pull --ff-only'))
  assert.ok(commands.includes('git branch -D feat/x'))
})

test('a PR closed without merging can still release its deferrals', () => {
  const h = harness({ state: 'CLOSED' })
  const path = ledgerWith(['name the select'])
  const result = landed({
    exec: h.exec,
    parsed: {
      pr: 7,
      dispositions: ['dropped:the screen was removed'],
      dryRun: false,
    },
    ledger: path,
  })
  assert.equal(result.state, 'CLOSED')
  assert.deepEqual(readLedger(path).entries, [])
})

test('each disposition is recorded against the finding it answers', () => {
  const h = harness()
  const result = landed({
    exec: h.exec,
    parsed: {
      pr: 7,
      dispositions: ['issue:filed as #1666', 'dropped:single occurrence'],
      dryRun: false,
    },
    ledger: ledgerWith(['name the select', 'evict snapshots']),
  })
  assert.deepEqual(result.discharged, [
    { finding: 'name the select', kind: 'issue', note: 'filed as #1666' },
    { finding: 'evict snapshots', kind: 'dropped', note: 'single occurrence' },
  ])
})

test('an unlanded PR is refused', () => {
  const h = harness({ state: 'OPEN' })
  assert.throws(
    () =>
      landed({
        exec: h.exec,
        parsed: { pr: 7, dispositions: ['dropped:x'], dryRun: false },
        ledger: ledgerWith(['name the select']),
      }),
    /is OPEN; discharge it once it has landed/u,
  )
})

test('local cleanup failure does not leave the deferral blocking every publish', () => {
  // A linked worktree already on main, a dirty tree, or a non-ff pull must not
  // strand the entry: the discharge is the point, the sync is convenience.
  const path = ledgerWith(['name the select'])
  const exec = (file, args) => {
    if (file === 'gh')
      return JSON.stringify({ state: 'MERGED', headRefName: 'feat/x' })
    if (args[0] === 'checkout') throw new Error('already checked out elsewhere')
    return ''
  }
  const result = landed({
    exec,
    parsed: {
      pr: 7,
      dispositions: ['fixed:addressed in a later commit'],
      dryRun: false,
    },
    ledger: path,
  })
  assert.deepEqual(readLedger(path).entries, [])
  assert.equal(result.problems.length, 1)
  // An unfinished cleanup must not read as a finished lifecycle.
  assert.equal(result.exitCode, 1)
})

test('a rerun after a cleanup failure says what to do instead of a bare count', () => {
  const h = harness()
  assert.throws(
    () =>
      landed({
        exec: h.exec,
        parsed: { pr: 7, dispositions: ['fixed:done'], dryRun: false },
        ledger: emptyLedger(),
      }),
    /holds no entry for that PR/u,
  )
})

test('a deferral the change later fixed can be closed as fixed', () => {
  const h = harness()
  const result = landed({
    exec: h.exec,
    parsed: { pr: 7, dispositions: ['fixed:done in a5c1e2f'], dryRun: false },
    ledger: ledgerWith(['name the select']),
  })
  assert.deepEqual(result.discharged, [
    { finding: 'name the select', kind: 'fixed', note: 'done in a5c1e2f' },
  ])
  assert.equal(result.exitCode, 0)
})
