import { execFileSync } from 'node:child_process'
import { join, resolve } from 'node:path'

function commandOutput(file, args) {
  return execFileSync(file, args, { encoding: 'utf8' }).trim()
}

export function screenCaptureOutputRoot(run = commandOutput) {
  const gitDir = resolve(run('git', ['rev-parse', '--absolute-git-dir']).trim())
  return join(gitDir, 'artifactshare', 'screen-captures')
}

export function screenCaptureOutputDirectory(
  label,
  outputRoot = screenCaptureOutputRoot(),
) {
  return join(resolve(outputRoot), label)
}
