import { appendFile, mkdir, readFile, stat } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { PROJECT_CONFIG_LOCAL_PATH } from './destination.js'

export type GitExcludeResult = {
  applied: boolean
  warning: string | null
}

export async function ensureGitExclude(cwd: string): Promise<GitExcludeResult> {
  const git = await findGitDir(cwd)
  if (!git) {
    return { applied: false, warning: null }
  }

  const excludePath = join(git.gitDir, 'info', 'exclude')
  const excludeEntry = gitPattern(
    relative(git.workTree, resolve(cwd, PROJECT_CONFIG_LOCAL_PATH)),
  )
  try {
    const existing = await readFile(excludePath, 'utf8').catch(() => '')
    if (excludeLines(existing).includes(excludeEntry)) {
      return { applied: false, warning: null }
    }
    await mkdir(dirname(excludePath), { recursive: true })
    const prefix = existing.endsWith('\n') || existing.length === 0 ? '' : '\n'
    await appendFile(excludePath, `${prefix}${excludeEntry}\n`, 'utf8')
    return { applied: true, warning: null }
  } catch {
    return {
      applied: false,
      warning: `Could not update ${excludePath}; keep ${PROJECT_CONFIG_LOCAL_PATH} out of version control manually.`,
    }
  }
}

function excludeLines(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'))
}

type GitRepository = {
  gitDir: string
  workTree: string
}

async function findGitDir(start: string): Promise<GitRepository | null> {
  let current = resolve(start)
  const root = resolve(current, '/')

  while (true) {
    const gitPath = join(current, '.git')
    const gitDir = await resolveGitDir(gitPath)
    if (gitDir) return { gitDir, workTree: current }
    if (current === root) return null
    current = dirname(current)
  }
}

async function resolveGitDir(gitPath: string): Promise<string | null> {
  const info = await stat(gitPath).catch(() => null)
  if (!info) return null
  if (info.isDirectory()) return gitPath
  if (!info.isFile()) return null

  const text = await readFile(gitPath, 'utf8').catch(() => null)
  if (!text) return null
  const match = text.match(/^gitdir:\s*(.+)$/m)
  const gitDir = match?.[1]?.trim()
  if (!gitDir) return null
  const resolvedGitDir = resolve(dirname(gitPath), gitDir)
  const commonDir = await readFile(join(resolvedGitDir, 'commondir'), 'utf8')
    .then((value) => value.trim())
    .catch(() => null)
  return commonDir ? resolve(resolvedGitDir, commonDir) : resolvedGitDir
}

function gitPattern(path: string): string {
  return path.split('\\').join('/')
}
