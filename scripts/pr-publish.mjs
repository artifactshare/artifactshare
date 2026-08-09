import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import { inspectMetadata } from './public-development-guard.mjs'

function output(exec, file, args) {
  return exec(file, args, { encoding: 'utf8' }).trim()
}

function currentPr(exec, branch) {
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
        'number,state,headRefOid,baseRefOid,baseRefName',
      ]),
    )
  } catch (error) {
    throw new Error(
      `GitHub PR query failed; no write performed: ${error.message}`,
    )
  }
  if (!Array.isArray(rows))
    throw new Error('GitHub PR query returned invalid JSON; no write performed')
  if (rows.length > 1)
    throw new Error(
      'multiple open PRs found for current branch; no write performed',
    )
  return rows[0] ?? null
}

export function publishPullRequest({
  bodyFile,
  title,
  exec = execFileSync,
  readFile = fs.readFileSync,
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
  if (!branch) throw new Error('current branch is required')
  try {
    exec('git', ['fetch', 'origin', 'main'])
  } catch (error) {
    throw new Error(`fetch failed before PR publication: ${error.message}`)
  }
  const snapshot = () => ({
    head: output(exec, 'git', ['rev-parse', 'HEAD']),
    base: output(exec, 'git', ['merge-base', 'origin/main', 'HEAD']),
  })
  const before = snapshot()
  const prBefore = currentPr(exec, branch)
  if (prBefore && prBefore.baseRefName !== 'main')
    throw new Error(
      `pull request base must be main, found ${prBefore.baseRefName}; no write performed`,
    )
  try {
    exec('git', ['fetch', 'origin', 'main'])
  } catch (error) {
    throw new Error(
      `stale check fetch failed; no GitHub write: ${error.message}`,
    )
  }
  const after = snapshot()
  const prAfter = currentPr(exec, branch)
  const samePr = JSON.stringify(prBefore) === JSON.stringify(prAfter)
  if (after.base !== before.base || after.head !== before.head || !samePr)
    throw new Error(
      'base, local HEAD, or remote PR metadata changed during inspection; rerun pnpm pr:publish',
    )
  if (prAfter) {
    try {
      exec('gh', [
        'pr',
        'edit',
        String(prAfter.number),
        '--title',
        title,
        '--body-file',
        bodyFile,
      ])
    } catch (error) {
      throw new Error(
        `GitHub body update failed; push not attempted: ${error.message}`,
      )
    }
    return { mode: 'update', number: prAfter.number }
  }
  try {
    exec('git', ['push', '--set-upstream', 'origin', branch])
  } catch (error) {
    throw new Error(`push failed before PR creation: ${error.message}`)
  }
  try {
    exec('gh', [
      'pr',
      'create',
      '--draft',
      '--title',
      title,
      '--body-file',
      bodyFile,
    ])
  } catch (error) {
    throw new Error(`draft PR creation failed after push: ${error.message}`)
  }
  return { mode: 'create' }
}

export function parsePublishArgs(args) {
  const values = {}
  const start = args[0] === '--' ? 1 : 0
  for (let index = start; index < args.length; index++) {
    const name = args[index]
    if (name !== '--body-file' && name !== '--title')
      throw new Error(`unknown argument: ${name}`)
    if (values[name]) throw new Error(`duplicate argument: ${name}`)
    const value = args[++index]
    if (!value || value.startsWith('--'))
      throw new Error(`missing value for ${name}`)
    values[name] = value
  }
  return { bodyFile: values['--body-file'], title: values['--title'] }
}

if (process.argv[1]?.endsWith('pr-publish.mjs')) {
  publishPullRequest(parsePublishArgs(process.argv.slice(2)))
}
