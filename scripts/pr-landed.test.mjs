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

function harness({ state = 'MERGED', branch = 'feat/x' } = {}) {
  const calls = []
  const exec = (file, args) => {
    calls.push([file, args])
    if (file === 'gh')
      return JSON.stringify({
        state,
        mergeCommit: { oid: 'c'.repeat(40) },
        headRefName: branch,
      })
    if (args[0] === 'branch' && args[1] === '--merged') return `  ${branch}\n`
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
  assert.ok(commands.includes('git checkout main'))
  assert.ok(commands.includes('git pull --ff-only'))
  assert.ok(commands.includes('git branch -d feat/x'))
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
  assert.ok(commands.includes('git checkout main'))
  assert.ok(commands.includes('git branch -d feat/x'))
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
