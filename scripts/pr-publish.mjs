import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import { pathToFileURL } from 'node:url'
import { inspectMetadata } from './public-development-guard.mjs'

function output(exec, file, args) {
  return exec(file, args, { encoding: 'utf8' }).trim()
}

function branchPullRequest(exec, branch) {
  let rows
  try {
    rows = JSON.parse(
      output(exec, 'gh', [
        'pr',
        'list',
        '--state',
        'open',
        '--json',
        'number,baseRefName,headRefName',
      ]),
    )
  } catch (error) {
    throw new Error(
      `GitHub PR query failed; no write performed: ${error.message}`,
    )
  }
  if (!Array.isArray(rows) || rows.length > 1)
    throw new Error(
      'GitHub PR query returned an unexpected result; no write performed',
    )
  const pr = rows[0] ?? null
  if (pr && pr.headRefName !== branch)
    throw new Error(
      'another branch already has the open PR; no write performed',
    )
  return pr
}

export function publishPullRequest({
  bodyFile,
  title,
  exec = execFileSync,
  readFile = fs.readFileSync,
  dryRun = false,
} = {}) {
  if (!bodyFile || !title)
    throw new Error(
      'Usage: pnpm pr:publish -- --body-file <path> --title <title>',
    )
  let body
  try {
    body = readFile(bodyFile, 'utf8')
  } catch (error) {
    throw new Error(
      `could not read PR body; no write performed: ${error.message}`,
    )
  }
  inspectMetadata(title, 'pull request title')
  inspectMetadata(body, 'pull request body')

  const branch = output(exec, 'git', ['branch', '--show-current'])
  if (!branch || branch === 'main')
    throw new Error('A topic branch is required.')
  const pr = branchPullRequest(exec, branch)
  if (pr && pr.baseRefName !== 'main')
    throw new Error(
      `pull request base must be main, found ${pr.baseRefName}; no write performed`,
    )
  if (dryRun)
    return { mode: pr ? 'update' : 'create', number: pr?.number, dryRun: true }

  if (pr) {
    exec('gh', [
      'pr',
      'edit',
      String(pr.number),
      '--title',
      title,
      '--body-file',
      bodyFile,
    ])
    return { mode: 'update', number: pr.number }
  }
  exec('git', ['push', '--set-upstream', 'origin', branch])
  exec('gh', [
    'pr',
    'create',
    '--draft',
    '--base',
    'main',
    '--title',
    title,
    '--body-file',
    bodyFile,
  ])
  return { mode: 'create' }
}

export function parsePublishArgs(args) {
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
    if (name !== '--body-file' && name !== '--title')
      throw new Error(`unknown argument: ${name}`)
    if (values[name]) throw new Error(`duplicate argument: ${name}`)
    const value = args[++index]
    if (!value || value.startsWith('--'))
      throw new Error(`missing value for ${name}`)
    values[name] = value
  }
  return {
    bodyFile: values['--body-file'],
    title: values['--title'],
    dryRun: values.dryRun,
    help: values.help,
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const options = parsePublishArgs(process.argv.slice(2))
  if (options.help)
    console.log(
      'Usage: pnpm pr:publish -- --body-file <path> --title <title> [--dry-run]',
    )
  else console.log(JSON.stringify(publishPullRequest(options)))
}
