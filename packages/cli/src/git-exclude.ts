import { dirname, join, relative, resolve } from 'node:path'
import { lstat } from 'node:fs/promises'
import { PROJECT_CONFIG_LOCAL_PATH } from './destination.js'
import {
  WriteBoundary,
  type WriteBoundaryDependencies,
} from './write-boundary.js'

export type GitExcludeResult = { applied: boolean; warning: string | null }

export async function ensureGitExclude(
  cwd: string,
  dependencies: WriteBoundaryDependencies = {},
): Promise<GitExcludeResult> {
  const boundary = new WriteBoundary(dependencies)
  let repository = resolve(cwd)
  let excludePath = join(repository, '.git', 'info', 'exclude')
  let line = PROJECT_CONFIG_LOCAL_PATH
  try {
    while (true) {
      await boundary.record(repository, true)
      const git = join(repository, '.git')
      const stat = await lstat(git).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return null
        throw error
      })
      if (stat) break
      const parent = dirname(repository)
      if (parent === repository) return { applied: false, warning: null }
      repository = parent
    }
    const git = join(repository, '.git')
    excludePath = join(git, 'info', 'exclude')
    line = relative(repository, resolve(cwd, PROJECT_CONFIG_LOCAL_PATH))
      .split('\\')
      .join('/')
    boundary.watch(join(git, 'gitdir'), join(git, 'commondir'))
    await boundary.record(git, true)
    for (const name of ['gitdir', 'commondir']) {
      if (await boundary.record(join(git, name)))
        throw new Error('Redirect metadata')
    }
    await boundary.record(dirname(excludePath), true)
    const existing = (await boundary.read(excludePath)) ?? ''
    if (existing.split('\n').some((value) => value.trim() === line)) {
      return { applied: false, warning: null }
    }
    await boundary.directory(dirname(excludePath))
    const prefix = existing.length && !existing.endsWith('\n') ? '\n' : ''
    await boundary.atomicWrite(excludePath, `${existing}${prefix}${line}\n`)
    boundary.keep(excludePath)
    await boundary.cleanup()
    return { applied: true, warning: null }
  } catch {
    try {
      await boundary.cleanup()
    } catch {
      /* Keep unknown or changed entries intact. */
    }
    return {
      applied: false,
      warning: `Could not update ${excludePath}; add ${line} to the repository's Git excludes manually.`,
    }
  }
}
