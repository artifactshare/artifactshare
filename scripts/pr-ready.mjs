import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

function output(exec, file, args) {
  return exec(file, args, { encoding: 'utf8' }).trim()
}

function openPullRequests(exec) {
  return JSON.parse(
    output(exec, 'gh', [
      'pr',
      'list',
      '--state',
      'open',
      '--json',
      'number,isDraft,baseRefName,headRefName,headRefOid',
    ]),
  )
}

function parseArgs(args) {
  const values = { dryRun: false }
  for (let index = args[0] === '--' ? 1 : 0; index < args.length; index += 1) {
    const name = args[index]
    if (name === '--dry-run') {
      values.dryRun = true
      continue
    }
    if (!['--codex-go', '--claude-go'].includes(name))
      throw new Error(`Unknown option: ${name}`)
    const value = args[++index]
    if (!value || value.startsWith('--'))
      throw new Error(`Missing value for ${name}`)
    values[name.slice(2).replace('-', '')] = value
  }
  if (!values.codexgo || !values.claudego)
    throw new Error(
      'Usage: pnpm pr:ready -- --codex-go <SHA> --claude-go <SHA>',
    )
  return {
    codexGo: values.codexgo,
    claudeGo: values.claudego,
    dryRun: values.dryRun,
  }
}

function ready(options = {}) {
  const exec = options.exec ?? execFileSync
  const parsed = options.parsed ?? parseArgs(process.argv.slice(2))
  const branch = output(exec, 'git', ['branch', '--show-current'])
  const head = output(exec, 'git', ['rev-parse', 'HEAD'])
  if (!branch) throw new Error('Current branch is required.')
  if (output(exec, 'git', ['status', '--porcelain']))
    throw new Error('Working tree must be clean.')
  if (parsed.codexGo !== head || parsed.claudeGo !== head)
    throw new Error('Both reviewer SHA values must equal HEAD.')
  const rows = openPullRequests(exec)
  if (rows.length !== 1) throw new Error('Exactly one open PR is required.')
  const pr = rows[0]
  if (
    pr.headRefName !== branch ||
    !pr.isDraft ||
    pr.baseRefName !== 'main' ||
    pr.headRefOid !== head
  )
    throw new Error('PR must be a pushed Draft targeting main.')
  if (!parsed.dryRun) {
    exec('gh', ['pr', 'ready', String(pr.number)])
    try {
      const confirmed = openPullRequests(exec).find(
        ({ number }) => number === pr.number,
      )
      if (!confirmed || confirmed.isDraft || confirmed.headRefOid !== head)
        throw new Error('PR changed while becoming ready.')
    } catch (error) {
      try {
        exec('gh', ['pr', 'ready', String(pr.number), '--undo'])
      } catch (restoreError) {
        throw new Error(
          `Ready confirmation and Draft restoration failed: ${restoreError.message}`,
        )
      }
      throw new Error(`${error.message} Restored Draft.`)
    }
  }
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
