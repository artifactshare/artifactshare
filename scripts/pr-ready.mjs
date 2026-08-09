import { execFileSync } from 'node:child_process'

function output(exec, file, args) {
  return exec(file, args, { encoding: 'utf8' }).trim()
}

function currentPullRequests(exec, branch) {
  let rows
  try {
    rows = JSON.parse(
      output(exec, 'gh', [
        'pr',
        'list',
        '--head',
        branch,
        '--state',
        'open',
        '--json',
        'number,isDraft,baseRefName,headRefOid',
      ]),
    )
  } catch (error) {
    throw new Error(
      `GitHub PR query failed; no write performed: ${error.message}`,
    )
  }
  if (!Array.isArray(rows))
    throw new Error('GitHub PR query returned invalid JSON; no write performed')
  return rows
}

export function readyPullRequest({
  codexGo,
  claudeGo,
  exec = execFileSync,
} = {}) {
  if (!codexGo || !claudeGo)
    throw new Error(
      'Usage: pnpm pr:ready -- --codex-go <SHA> --claude-go <SHA>',
    )
  const branch = output(exec, 'git', ['branch', '--show-current'])
  if (!branch) throw new Error('current branch is required; no write performed')
  const dirty = output(exec, 'git', ['status', '--porcelain'])
  if (dirty) throw new Error('working tree must be clean; no write performed')
  const head = output(exec, 'git', ['rev-parse', 'HEAD'])
  if (codexGo !== head || claudeGo !== head)
    throw new Error(
      'both reviewer GO values must equal local HEAD; no write performed',
    )
  const rows = currentPullRequests(exec, branch)
  if (rows.length !== 1)
    throw new Error(
      `exactly one open PR is required for ${branch}, found ${rows.length}; no write performed`,
    )
  const pr = rows[0]
  if (pr.baseRefName !== 'main')
    throw new Error(
      `pull request base must be main, found ${pr.baseRefName}; no write performed`,
    )
  if (!pr.isDraft)
    throw new Error('pull request must still be draft; no write performed')
  if (pr.headRefOid !== head)
    throw new Error(
      'local HEAD must be pushed before readying the PR; no write performed',
    )
  try {
    exec('gh', ['pr', 'ready', String(pr.number)])
  } catch (error) {
    throw new Error(`GitHub ready operation failed: ${error.message}`)
  }
  return { number: pr.number, head }
}

export function parseReadyArgs(args) {
  const values = {}
  const start = args[0] === '--' ? 1 : 0
  for (let index = start; index < args.length; index += 1) {
    const name = args[index]
    if (name !== '--codex-go' && name !== '--claude-go')
      throw new Error(`unknown argument: ${name}`)
    if (values[name]) throw new Error(`duplicate argument: ${name}`)
    const value = args[++index]
    if (!value || value.startsWith('--'))
      throw new Error(`missing value for ${name}`)
    values[name] = value
  }
  return { codexGo: values['--codex-go'], claudeGo: values['--claude-go'] }
}

if (process.argv[1]?.endsWith('pr-ready.mjs')) {
  readyPullRequest(parseReadyArgs(process.argv.slice(2)))
}
