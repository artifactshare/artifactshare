import { execFileSync } from 'node:child_process'
import { appendFileSync } from 'node:fs'

export const MODELS = {
  access: 'verify-artifact-access',
  billing: 'verify-billing-sync',
  'cli-refresh': 'verify-cli-refresh-rotation',
}

export async function modelPaths(skill) {
  const { COVERS } = await import(`../../.claude/skills/${skill}/check.mjs`)
  return [...COVERS, `.claude/skills/${skill}/`, 'scripts/lib/tlc-check.mjs']
}

export function touches(paths, files) {
  return files.some((file) =>
    paths.some((path) =>
      path.endsWith('/') ? file.startsWith(path) : file === path,
    ),
  )
}

export async function selectModels(files) {
  const selected = {}
  for (const [name, skill] of Object.entries(MODELS))
    selected[name] = files === 'all' || touches(await modelPaths(skill), files)
  return selected
}

function changedFiles(base, head) {
  if (!base || !head)
    throw new Error('PUBLIC_PR_BASE and PUBLIC_PR_HEAD are required')
  const commit = (ref) =>
    execFileSync(
      'git',
      ['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`],
      { encoding: 'utf8' },
    ).trim()
  return execFileSync(
    'git',
    [
      'diff',
      '--name-only',
      '-z',
      '--no-renames',
      `${commit(base)}...${commit(head)}`,
      '--',
    ],
    { encoding: 'utf8' },
  )
    .split('\0')
    .filter(Boolean)
}

if (import.meta.main) {
  const { EVENT_NAME, PUBLIC_PR_BASE, PUBLIC_PR_HEAD, GITHUB_OUTPUT } =
    process.env
  const selected = await selectModels(
    EVENT_NAME === 'merge_group'
      ? 'all'
      : changedFiles(PUBLIC_PR_BASE, PUBLIC_PR_HEAD),
  )
  const lines = Object.entries(selected).map(([name, run]) => `${name}=${run}`)
  console.log(lines.join('\n'))
  if (GITHUB_OUTPUT) appendFileSync(GITHUB_OUTPUT, `${lines.join('\n')}\n`)
}
