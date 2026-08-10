import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import {
  isClaudeVersion,
  receiptGitPath,
  resultGitPath,
  reviewLevel,
} from './claude-review.mjs'

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
        '--state',
        'open',
        '--json',
        'number,isDraft,baseRefName,headRefName,headRefOid',
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

export function validateClaudeGateReceipt(
  receipt,
  { head, risk, target, baseSha, resultBytes },
) {
  const startedAt = Date.parse(receipt?.startedAt)
  const finishedAt = Date.parse(receipt?.finishedAt)
  const digest = createHash('sha256').update(resultBytes).digest('hex')
  if (
    !receipt ||
    receipt.sha !== head ||
    receipt.depth !== 'gate' ||
    receipt.risk !== risk ||
    receipt.requestedLevel !== reviewLevel('gate', risk) ||
    receipt.target !== target ||
    receipt.baseSha !== baseSha ||
    !isClaudeVersion(receipt.claudeVersion) ||
    !Number.isFinite(startedAt) ||
    !Number.isFinite(finishedAt) ||
    finishedAt < startedAt ||
    receipt.resultBytes !== resultBytes.length ||
    receipt.resultSha256 !== digest
  )
    throw new Error(
      'Claude gate review receipt is missing or inconsistent; no write performed',
    )
  return { ...receipt, resultSha256: digest }
}

export function readClaudeGateReceipt(
  exec,
  head,
  risk,
  readFile = readFileSync,
) {
  const receiptPath = output(exec, 'git', [
    'rev-parse',
    '--path-format=absolute',
    '--git-path',
    receiptGitPath,
  ])
  const resultPath = output(exec, 'git', [
    'rev-parse',
    '--path-format=absolute',
    '--git-path',
    resultGitPath,
  ])
  if (!receiptPath || !resultPath)
    throw new Error('Claude gate review paths are empty; no write performed')
  let receipt
  let resultBytes
  try {
    receipt = JSON.parse(readFile(receiptPath, 'utf8'))
    resultBytes = readFile(resultPath)
  } catch (error) {
    throw new Error(
      `Claude gate review is missing or invalid; no write performed: ${error.message}`,
    )
  }
  const target = `origin/main...${head}`
  const baseSha = output(exec, 'git', [
    'rev-parse',
    '--verify',
    '--end-of-options',
    'origin/main^{commit}',
  ])
  return validateClaudeGateReceipt(receipt, {
    head,
    risk,
    target,
    baseSha,
    resultBytes,
  })
}

export function readyPullRequest({
  codexGo,
  claudeGo,
  claudeRisk,
  dryRun = false,
  exec = execFileSync,
  readGateReceipt = (runner, sha, risk) =>
    readClaudeGateReceipt(runner, sha, risk),
} = {}) {
  if (!codexGo || !claudeGo || !['normal', 'high'].includes(claudeRisk))
    throw new Error(
      'Usage: pnpm pr:ready -- --codex-go <SHA> --claude-go <SHA> --claude-risk <normal|high>',
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
  const receipt = readGateReceipt(exec, head, claudeRisk)
  const rows = currentPullRequests(exec, branch)
  if (rows.length !== 1)
    throw new Error(
      `exactly one open PR is required for ${branch}, found ${rows.length}; no write performed`,
    )
  const pr = rows[0]
  if (pr.headRefName !== branch)
    throw new Error(
      'the repository open PR belongs to another branch; no write performed',
    )
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
  if (dryRun)
    return {
      number: pr.number,
      head,
      claudeReviewSha256: receipt.resultSha256,
      dryRun: true,
    }
  try {
    exec('gh', ['pr', 'ready', String(pr.number)])
  } catch (error) {
    throw new Error(`GitHub ready operation failed: ${error.message}`)
  }
  let confirmed
  try {
    confirmed = currentPullRequests(exec, branch).find(
      ({ number }) => number === pr.number,
    )
  } catch (error) {
    try {
      exec('gh', ['pr', 'ready', String(pr.number), '--undo'])
    } catch (restoreError) {
      throw new Error(
        `ready confirmation failed and Draft restoration failed: ${restoreError.message}`,
      )
    }
    throw new Error(
      `ready confirmation failed; restored Draft and discarded reviewer GO: ${error.message}`,
    )
  }
  if (!confirmed || confirmed.isDraft || confirmed.headRefOid !== head) {
    try {
      exec('gh', ['pr', 'ready', String(pr.number), '--undo'])
    } catch (error) {
      throw new Error(
        `pull request changed during readying and Draft restoration failed: ${error.message}`,
      )
    }
    throw new Error(
      'pull request changed during readying; restored Draft and discarded reviewer GO',
    )
  }
  return { number: pr.number, head, claudeReviewSha256: receipt.resultSha256 }
}

export function parseReadyArgs(args) {
  const values = { dryRun: false, help: false }
  const start = args[0] === '--' ? 1 : 0
  for (let index = start; index < args.length; index += 1) {
    const name = args[index]
    if (name === '--help' || name === '-h') {
      values.help = true
      continue
    }
    if (name === '--dry-run') {
      values.dryRun = true
      continue
    }
    if (
      name !== '--codex-go' &&
      name !== '--claude-go' &&
      name !== '--claude-risk'
    )
      throw new Error(`unknown argument: ${name}`)
    if (values[name]) throw new Error(`duplicate argument: ${name}`)
    const value = args[++index]
    if (!value || value.startsWith('--'))
      throw new Error(`missing value for ${name}`)
    values[name] = value
  }
  return {
    codexGo: values['--codex-go'],
    claudeGo: values['--claude-go'],
    claudeRisk: values['--claude-risk'],
    dryRun: values.dryRun,
    help: values.help,
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const options = parseReadyArgs(process.argv.slice(2))
  if (options.help)
    console.log(
      'Usage: pnpm pr:ready -- --codex-go <SHA> --claude-go <SHA> --claude-risk <normal|high> [--dry-run]',
    )
  else console.log(JSON.stringify(readyPullRequest(options)))
}
