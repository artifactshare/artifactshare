import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { basename, dirname, join, resolve } from 'node:path'

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
