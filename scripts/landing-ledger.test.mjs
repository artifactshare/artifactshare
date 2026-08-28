import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  dischargeEntry,
  outstandingEntries,
  readLedger,
  recordDeferred,
  writeLedgerAtomic,
} from './landing-ledger.mjs'

const dir = () => mkdtempSync(join(tmpdir(), 'as-landing-ledger-'))

test('a missing ledger reads as nothing deferred', () => {
  assert.deepEqual(readLedger(join(dir(), 'absent.json')), {
    schema_version: 1,
    entries: [],
  })
})

test('an unreadable ledger is reported rather than read as empty', () => {
  const path = join(dir(), 'ledger.json')
  writeFileSync(path, '{ not json')
  const ledger = readLedger(path)
  assert.equal(ledger.unreadable, true)
  assert.deepEqual(outstandingEntries(ledger), [])
})

test('deferred findings round-trip and replace the entry for their PR', () => {
  const path = join(dir(), 'ledger.json')
  const first = recordDeferred(readLedger(path), {
    pr: 12,
    head: 'a'.repeat(40),
    deferred: ['name the select for screen readers'],
  })
  writeLedgerAtomic(path, first)
  assert.equal(outstandingEntries(readLedger(path)).length, 1)

  const replaced = recordDeferred(readLedger(path), {
    pr: 12,
    head: 'b'.repeat(40),
    deferred: [
      'name the select for screen readers',
      'evict abandoned snapshots',
    ],
  })
  writeLedgerAtomic(path, replaced)
  const entries = outstandingEntries(readLedger(path))
  assert.equal(entries.length, 1)
  assert.equal(entries[0].deferred.length, 2)
})

test('a second pr:ready run cannot drop what the first recorded', () => {
  let ledger = recordDeferred(
    { schema_version: 1, entries: [] },
    {
      pr: 12,
      head: 'a'.repeat(40),
      deferred: ['name the select', 'evict snapshots'],
    },
  )
  // A rerun after a failed check, with nothing new to add.
  ledger = recordDeferred(ledger, {
    pr: 12,
    head: 'b'.repeat(40),
    deferred: [],
  })
  assert.deepEqual(outstandingEntries(ledger)[0].deferred, [
    'name the select',
    'evict snapshots',
  ])
})

test('a PR that deferred nothing leaves no entry', () => {
  const ledger = recordDeferred(
    { schema_version: 1, entries: [] },
    { pr: 3, head: 'c'.repeat(40), deferred: [] },
  )
  assert.deepEqual(outstandingEntries(ledger), [])
})

test('discharging removes only the named PR', () => {
  let ledger = { schema_version: 1, entries: [] }
  ledger = recordDeferred(ledger, {
    pr: 1,
    head: 'd'.repeat(40),
    deferred: ['x'],
  })
  ledger = recordDeferred(ledger, {
    pr: 2,
    head: 'e'.repeat(40),
    deferred: ['y'],
  })
  const after = dischargeEntry(ledger, 1)
  assert.deepEqual(
    outstandingEntries(after).map((entry) => entry.pr),
    [2],
  )
})

test('an entry without deferred items is rejected on write', () => {
  assert.throws(
    () =>
      writeLedgerAtomic(join(dir(), 'ledger.json'), {
        schema_version: 1,
        entries: [{ pr: 1, head: 'f'.repeat(40), deferred: [] }],
      }),
    /at least one deferred item/u,
  )
})
