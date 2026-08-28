import { execFileSync } from 'node:child_process'
import {
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { randomUUID } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'

/** Findings a review round raised and the change deliberately did not fix are
 * recorded when the PR is made ready, and discharged after it lands. The next
 * `pr:publish` refuses while a record is outstanding, so a deferral surfaces at
 * the start of the following change instead of depending on anyone recalling
 * it hours later. */

function commandOutput(file, args) {
  return execFileSync(file, args, { encoding: 'utf8' }).trim()
}

export function ledgerPath(run = commandOutput) {
  return join(
    resolve(run('git', ['rev-parse', '--git-common-dir'])),
    'artifactshare',
    'landing-ledger.json',
  )
}

export function assertLedger(ledger) {
  if (typeof ledger !== 'object' || ledger === null)
    throw new Error('landing ledger must be an object')
  if (ledger.schema_version !== 1)
    throw new Error('landing ledger schema_version must be 1')
  if (!Array.isArray(ledger.entries))
    throw new Error('landing ledger entries must be an array')
  for (const entry of ledger.entries) {
    if (typeof entry !== 'object' || entry === null)
      throw new Error('landing ledger entry must be an object')
    if (!Number.isInteger(entry.pr) || entry.pr <= 0)
      throw new Error('landing ledger entry needs a positive pr number')
    if (typeof entry.head !== 'string' || entry.head === '')
      throw new Error('landing ledger entry needs the head commit')
    if (!Array.isArray(entry.deferred) || entry.deferred.length === 0)
      throw new Error('landing ledger entry needs at least one deferred item')
    for (const item of entry.deferred) {
      if (typeof item !== 'string' || item.trim() === '')
        throw new Error('deferred items must be non-empty strings')
    }
  }
  return ledger
}

export function readLedger(path) {
  let raw
  try {
    raw = readFileSync(path, 'utf8')
  } catch (error) {
    // No ledger yet is the ordinary first-run state. Anything else — a
    // permission or I/O failure — must not read as "nothing deferred", which
    // is the exact loss this record exists to prevent.
    if (error?.code === 'ENOENT') return { schema_version: 1, entries: [] }
    return { schema_version: 1, entries: [], unreadable: true }
  }
  try {
    return assertLedger(JSON.parse(raw))
  } catch {
    return { schema_version: 1, entries: [], unreadable: true }
  }
}

export function writeLedgerAtomic(path, ledger) {
  assertLedger(ledger)
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`
  try {
    writeFileSync(temporary, `${JSON.stringify(ledger, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    })
    renameSync(temporary, path)
  } finally {
    rmSync(temporary, { force: true })
  }
}

/** Deferrals accumulate until they are discharged. `pr:ready` runs again after
 * a failed check, and replacing the entry wholesale would let a second run with
 * a shorter list — or `--no-deferred` — quietly drop what the first one
 * recorded. */
export function recordDeferred(ledger, { pr, head, deferred }) {
  const others = (ledger.entries ?? []).filter((entry) => entry.pr !== pr)
  const previous =
    (ledger.entries ?? []).find((entry) => entry.pr === pr)?.deferred ?? []
  const merged = [...previous]
  for (const item of deferred) if (!merged.includes(item)) merged.push(item)
  if (merged.length === 0) return { schema_version: 1, entries: others }
  return {
    schema_version: 1,
    entries: [...others, { pr, head, deferred: merged }],
  }
}

export function dischargeEntry(ledger, pr) {
  return {
    schema_version: 1,
    entries: (ledger.entries ?? []).filter((entry) => entry.pr !== pr),
  }
}

export function outstandingEntries(ledger) {
  return ledger.entries ?? []
}
