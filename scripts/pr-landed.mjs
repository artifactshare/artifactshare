import { execFileSync } from 'node:child_process'
import { rmSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { roundsPathsForBranch } from './review-rounds.mjs'
import {
  dischargeEntry,
  ledgerPath,
  outstandingEntries,
  readLedger,
  writeLedgerAtomic,
} from './landing-ledger.mjs'

/** Run after a PR lands. It finishes the local lifecycle and forces every
 * finding the change deferred to reach a disposition, which is the step no
 * feature task ever reaches on its own: mid-change the right call is to keep
 * the scope, and by the time it lands nobody is looking. */

function output(exec, file, args) {
  return exec(file, args, { encoding: 'utf8' }).trim()
}

/** `fixed` closes a deferral the change ended up addressing after all: reruns
 * of `pr:ready` merge rather than replace, so an item recorded once stays until
 * it is dispositioned here. */
const DISPOSITIONS = new Set(['issue', 'promoted', 'dropped', 'fixed'])

export function parseLandedArgs(args) {
  const normalized = args[0] === '--' ? args.slice(1) : args
  const values = { pr: undefined, dispositions: [], dryRun: false }
  for (let index = 0; index < normalized.length; index += 1) {
    const name = normalized[index]
    if (name === '--dry-run') {
      values.dryRun = true
      continue
    }
    const value = normalized[++index]
    if (!value || value.startsWith('--')) throw new Error(usage())
    if (name === '--pr') values.pr = Number.parseInt(value, 10)
    else if (name === '--disposition') values.dispositions.push(value)
    else throw new Error(usage())
  }
  if (!Number.isInteger(values.pr) || values.pr <= 0) throw new Error(usage())
  return values
}

function usage() {
  return 'Usage: pnpm pr:landed -- --pr <number> [--disposition issue|promoted|dropped|fixed:<note> ...] [--dry-run]'
}

/** A disposition is `kind:note`. `dropped` states why the item is not worth
 * doing; `issue` and `promoted` name where it went. A bare kind is refused so
 * that "handled" always carries evidence. */
export function parseDisposition(raw) {
  const separator = raw.indexOf(':')
  if (separator <= 0) throw new Error(`disposition needs kind:note — ${raw}`)
  const kind = raw.slice(0, separator).trim()
  const note = raw.slice(separator + 1).trim()
  if (!DISPOSITIONS.has(kind))
    throw new Error(
      `disposition kind must be issue, promoted, dropped, or fixed — ${raw}`,
    )
  if (note === '') throw new Error(`disposition needs a note — ${raw}`)
  return { kind, note }
}

export function landed({
  exec = execFileSync,
  parsed = parseLandedArgs(process.argv.slice(2)),
  ledger = undefined,
} = {}) {
  const path = ledger ?? ledgerPath()
  const state = readLedger(path)
  if (state.unreadable)
    throw new Error(
      `The landing ledger at ${path} could not be read. Repair or remove it, then retry.`,
    )
  // A change that deferred nothing still finishes its lifecycle here, so a
  // missing entry means "nothing to discharge" rather than an error.
  const entry = outstandingEntries(state).find((row) => row.pr === parsed.pr)
  const deferred = entry?.deferred ?? []

  const view = JSON.parse(
    output(exec, 'gh', [
      'pr',
      'view',
      String(parsed.pr),
      '--json',
      'state,headRefName',
    ]),
  )
  // A PR closed without merging still has to release its deferrals, or every
  // later publish is refused with no way out but editing the ledger by hand.
  if (view.state !== 'MERGED' && view.state !== 'CLOSED')
    throw new Error(
      `PR #${parsed.pr} is ${view.state}; discharge it once it has landed or been closed.`,
    )

  const dispositions = parsed.dispositions.map(parseDisposition)
  if (dispositions.length !== deferred.length)
    throw new Error(
      [
        `PR #${parsed.pr} deferred ${deferred.length} finding(s); ${dispositions.length} disposition(s) given.`,
        ...(deferred.length === 0
          ? [
              'This ledger holds no entry for that PR. It may already be discharged, the number may be wrong, or the record may belong to another checkout.',
              'If it was discharged, rerun without --disposition to finish the local cleanup.',
            ]
          : []),
        ...deferred.map((item, index) => `  ${index + 1}. ${item}`),
        'Give one --disposition issue|promoted|dropped|fixed:<note> per item, in the same order.',
      ].join('\n'),
    )
  // Pair each note with the finding it answers. A count alone lets a note be
  // recorded against the wrong item, and this pairing is the record the
  // workflow promises.
  const discharged = deferred.map((finding, index) => ({
    finding,
    ...dispositions[index],
  }))

  const problems = []
  if (!parsed.dryRun) {
    // Discharge first. The sync and branch cleanup below are conveniences that
    // fail for ordinary local reasons — a linked worktree already on main, a
    // dirty tree, a non-fast-forward pull — and leaving the entry behind then
    // blocks every later publish with no way out but editing the file by hand.
    if (entry) writeLedgerAtomic(path, dischargeEntry(state, parsed.pr))
    try {
      output(exec, 'git', ['checkout', 'main'])
      output(exec, 'git', ['pull', '--ff-only'])
      const branch = view.headRefName
      if (branch && branch !== 'main') {
        const merged = exec('git', ['branch', '--merged', 'main'], {
          encoding: 'utf8',
        })
        if (merged.split('\n').some((line) => line.trim() === branch)) {
          output(exec, 'git', ['branch', '-d', branch])
          // A later branch of the same name must not inherit these rounds: the
          // recorded heads may not even exist after gc. Resolved through the
          // injected exec so a test never reaches the checkout's own state.
          for (const file of roundsPathsForBranch(branch, (name, args) =>
            output(exec, name, args),
          ))
            rmSync(file, { force: true })
        }
      }
    } catch (error) {
      problems.push(error instanceof Error ? error.message : String(error))
    }
  }
  return {
    pr: parsed.pr,
    state: view.state,
    discharged,
    problems,
    // The lifecycle is only finished when the cleanup finished too, and the
    // caller has to be able to see that without reading stdout.
    exitCode: problems.length > 0 ? 1 : 0,
    dryRun: parsed.dryRun,
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    const result = landed()
    process.exitCode = result.exitCode
    process.stdout.write(
      [
        `${result.dryRun ? 'Would discharge' : 'Discharged'} ${result.discharged.length} deferred finding(s) for PR #${result.pr} (${result.state}).`,
        ...result.discharged.map(
          (item) => `  ${item.kind}: ${item.finding} — ${item.note}`,
        ),
        ...result.problems.map(
          (problem) => `  local cleanup did not finish: ${problem}`,
        ),
        ...(result.problems.length > 0
          ? [
              '  The ledger is settled; rerun without --disposition once the checkout is clean.',
            ]
          : []),
        '',
      ].join('\n'),
    )
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    )
    process.exitCode = 1
  }
}
