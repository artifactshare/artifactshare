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

/** Run after a PR lands. It finishes the local lifecycle, releases the landing
 * ledger entry, fast-forwards main, and removes the merged branch when safe. */

function output(exec, file, args) {
  return exec(file, args, { encoding: 'utf8' }).trim()
}

export function parseLandedArgs(args) {
  const normalized = args[0] === '--' ? args.slice(1) : args
  const values = { pr: undefined, dryRun: false }
  for (let index = 0; index < normalized.length; index += 1) {
    const name = normalized[index]
    if (name === '--dry-run') {
      values.dryRun = true
      continue
    }
    const value = normalized[++index]
    if (!value || value.startsWith('--')) throw new Error(usage())
    if (name === '--pr') values.pr = Number.parseInt(value, 10)
    else throw new Error(usage())
  }
  if (!Number.isInteger(values.pr) || values.pr <= 0) throw new Error(usage())
  return values
}

function usage() {
  return 'Usage: pnpm pr:landed -- --pr <number> [--dry-run]'
}

/** Registered worktrees with the branch each has checked out (`null` when
 * detached); prunable registrations (directory gone) are left out. */
export function worktreeEntries(exec) {
  const porcelain = exec('git', ['worktree', 'list', '--porcelain'], {
    encoding: 'utf8',
  })
  const entries = []
  for (const line of porcelain.split('\n')) {
    if (line.startsWith('worktree '))
      entries.push({
        path: line.slice('worktree '.length),
        branch: null,
        prunable: false,
      })
    else if (line.startsWith('branch ') && entries.length > 0)
      entries.at(-1).branch = line.slice('branch '.length)
    else if (line.startsWith('prunable') && entries.length > 0)
      entries.at(-1).prunable = true
  }
  return entries.filter((entry) => !entry.prunable)
}

/** Worktree holding `refs/heads/<branch>`, or null. */
export function worktreeHolding(entries, branch) {
  return (
    entries.find((entry) => entry.branch === `refs/heads/${branch}`) ?? null
  )
}

/**
 * Fast-forward `main` wherever it is checked out, appending what changed to
 * `notes`. From a feature worktree this updates the worktree holding `main`
 * instead of failing on "'main' is already used by worktree"; the main
 * checkout (the first registered worktree) checks `main` out when nothing
 * holds it; another worktree refuses rather than hijack the shared branch.
 */
export function syncMain(exec, notes = []) {
  const here = output(exec, 'git', ['rev-parse', '--show-toplevel'])
  const entries = worktreeEntries(exec)
  const holder = worktreeHolding(entries, 'main')
  if (holder && holder.path !== here) {
    output(exec, 'git', ['-C', holder.path, 'pull', '--ff-only'])
    notes.push(`Fast-forwarded main in ${holder.path}`)
    return notes
  }
  if (!holder && entries.length > 0 && entries[0].path !== here)
    throw new Error(
      `No worktree has main checked out; run pr:landed from the main checkout (${entries[0].path}) or check main out there first.`,
    )
  if (!holder) {
    output(exec, 'git', ['checkout', 'main'])
    notes.push('Checked out main here')
  }
  output(exec, 'git', ['pull', '--ff-only'])
  notes.push('Fast-forwarded main here')
  return notes
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
  // missing entry means "nothing to release" rather than an error.
  const entry = outstandingEntries(state).find((row) => row.pr === parsed.pr)
  const releasedDeferred = entry?.deferred.length ?? 0

  const view = JSON.parse(
    output(exec, 'gh', [
      'pr',
      'view',
      String(parsed.pr),
      '--json',
      'state,headRefName',
    ]),
  )
  // A PR closed without merging still has to release its ledger entry, or every
  // later publish is refused with no way out but editing the ledger by hand.
  if (view.state !== 'MERGED' && view.state !== 'CLOSED')
    throw new Error(
      `PR #${parsed.pr} is ${view.state}; finish it once it has landed or been closed.`,
    )

  const problems = []
  const notes = []
  if (!parsed.dryRun) {
    // Release the ledger entry first. The sync and branch cleanup below are
    // conveniences that
    // fail for ordinary local reasons — a linked worktree already on main, a
    // dirty tree, a non-fast-forward pull — and leaving the entry behind then
    // blocks every later publish with no way out but editing the file by hand.
    if (entry) writeLedgerAtomic(path, dischargeEntry(state, parsed.pr))
    try {
      syncMain(exec, notes)
      const branch = view.headRefName
      if (branch && branch !== 'main') {
        // --format avoids the "* " / "+ " markers and any colour.
        // Full refs: a tag sharing the name would shorten differently.
        const merged = exec(
          'git',
          ['branch', '--merged', 'main', '--format=%(refname)'],
          { encoding: 'utf8' },
        )
        const isMerged = merged
          .split('\n')
          .some((line) => line.trim() === `refs/heads/${branch}`)
        const holder = worktreeHolding(worktreeEntries(exec), branch)
        const here = output(exec, 'git', ['rev-parse', '--show-toplevel'])
        if (isMerged && holder && holder.path !== here) {
          // git refuses to delete a branch another worktree has checked out.
          notes.push(
            `Left branch ${branch}: it is checked out in ${holder.path}; remove that worktree to delete it`,
          )
        } else if (isMerged) {
          // Deleting the branch this worktree has checked out is impossible,
          // so park the worktree on main's commit (detached) first.
          if (holder) {
            output(exec, 'git', ['checkout', '--detach', 'main'])
            notes.push('Parked this worktree on main (detached HEAD)')
          }
          // Merge status was checked against main above; -d would check it
          // against this worktree's HEAD instead.
          output(exec, 'git', ['branch', '-D', branch])
          notes.push(`Deleted branch ${branch}`)
        } else {
          notes.push(
            `Left branch ${branch}: not merged into main (${view.state})`,
          )
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
    releasedDeferred,
    notes,
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
        `${result.dryRun ? 'Would finish' : 'Finished'} landing cleanup for PR #${result.pr} (${result.state}); ${result.releasedDeferred} deferred finding(s) released.`,
        ...result.notes.map((note) => `  ${note}`),
        ...result.problems.map(
          (problem) => `  local cleanup did not finish: ${problem}`,
        ),
        ...(result.problems.length > 0
          ? ['  The ledger is settled; rerun once the checkout is clean.']
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
