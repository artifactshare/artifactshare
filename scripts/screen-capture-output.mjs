import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { mkdir, rm } from 'node:fs/promises'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'

function commandOutput(file, args) {
  return execFileSync(file, args, { encoding: 'utf8' }).trim()
}

export function screenCaptureOutputRoot(run = commandOutput) {
  const gitDir = resolve(run('git', ['rev-parse', '--absolute-git-dir']).trim())
  const checkout = resolve(run('git', ['rev-parse', '--show-toplevel']).trim())
  const parent = dirname(checkout)
  if (parent === checkout) {
    throw new Error(
      'Screen capture requires a checkout below the filesystem root',
    )
  }
  const worktreeId = createHash('sha256').update(gitDir).digest('hex')
  return join(parent, `.${basename(checkout)}-screen-captures`, worktreeId)
}

export function screenCaptureOutputDirectory(
  label,
  outputRoot = screenCaptureOutputRoot(),
) {
  return join(resolve(outputRoot), label)
}

// Resolve existing ancestors too: an output directory may not exist yet.
function physicalPath(path) {
  const absolute = resolve(path)
  try {
    return realpathSync(absolute)
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
    const parent = dirname(absolute)
    if (parent === absolute) throw error
    return join(physicalPath(parent), basename(absolute))
  }
}

function contains(parent, child) {
  const path = relative(parent, child)
  return (
    path === '' ||
    (path !== '..' && !path.startsWith(`..${sep}`) && !path.startsWith(sep))
  )
}

export function assertSafeCaptureOutput(paths, run = commandOutput) {
  const worktrees = run('git', ['worktree', 'list', '--porcelain', '-z'])
    .split('\0')
    .filter((field) => field.startsWith('worktree '))
    .map((field) => physicalPath(field.slice('worktree '.length)))
  if (!worktrees.length)
    throw new Error('Cannot determine registered worktrees')
  for (const path of paths) {
    const candidate = physicalPath(path)
    if (
      worktrees.some(
        (worktree) =>
          contains(worktree, candidate) || contains(candidate, worktree),
      )
    ) {
      throw new Error(`Capture output overlaps a registered worktree: ${path}`)
    }
  }
}

export async function removeCaptureOutput(
  outputRoot,
  target,
  run = commandOutput,
) {
  assertSafeCaptureOutput([outputRoot, target], run)
  await rm(target, { recursive: true, force: true })
}

export async function createCaptureOutput(
  outputRoot,
  target,
  run = commandOutput,
) {
  assertSafeCaptureOutput([outputRoot, target], run)
  await mkdir(target, { recursive: true })
}
