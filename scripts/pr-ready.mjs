import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

function output(exec, file, args) {
  return exec(file, args, { encoding: 'utf8' }).trim()
}

function parseArgs(args) {
  const normalized = args[0] === '--' ? args.slice(1) : args
  if (normalized.some((arg) => arg !== '--dry-run'))
    throw new Error('Usage: pnpm pr:ready -- [--dry-run]')
  return { dryRun: normalized.includes('--dry-run') }
}

function ready({
  exec = execFileSync,
  parsed = parseArgs(process.argv.slice(2)),
} = {}) {
  const branch = output(exec, 'git', ['branch', '--show-current'])
  const head = output(exec, 'git', ['rev-parse', 'HEAD'])
  if (!branch || branch === 'main')
    throw new Error('A topic branch is required.')
  if (output(exec, 'git', ['status', '--porcelain']))
    throw new Error('Working tree must be clean.')
  const rows = JSON.parse(
    output(exec, 'gh', [
      'pr',
      'list',
      '--state',
      'open',
      '--json',
      'number,isDraft,baseRefName,headRefName,headRefOid',
    ]),
  )
  if (!Array.isArray(rows) || rows.length !== 1)
    throw new Error('Exactly one open PR for the current branch is required.')
  const pr = rows[0]
  if (!pr.isDraft || pr.baseRefName !== 'main' || pr.headRefName !== branch)
    throw new Error(
      'PR must be a Draft targeting main from the current branch.',
    )
  if (pr.headRefOid !== head)
    throw new Error('Push the current HEAD before making the PR ready.')
  exec('gh', ['pr', 'checks', String(pr.number), '--required'])
  if (!parsed.dryRun) exec('gh', ['pr', 'ready', String(pr.number)])
  return { number: pr.number, head, dryRun: parsed.dryRun }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    const result = ready()
    process.stdout.write(
      `${result.dryRun ? 'Would mark' : 'Marked'} PR #${result.number} ready at ${result.head}.\n`,
    )
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    )
    process.exitCode = 1
  }
}

export { parseArgs, ready }
