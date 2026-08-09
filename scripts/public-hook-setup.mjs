import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const repo = process.cwd()
function gitPath(...args) {
  return execFileSync('git', ['rev-parse', '--git-path', ...args], {
    cwd: repo,
    encoding: 'utf8',
  }).trim()
}

try {
  const hookDirectory = path.resolve(repo, gitPath('hooks'))
  const hook = path.join(hookDirectory, 'pre-push')
  const guard = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    'public-development-guard.mjs',
  )
  const reviewGuard = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    'pre-push-review-guard.mjs',
  )
  const current = fs.existsSync(hook) ? fs.readFileSync(hook, 'utf8') : ''
  const managed = current.includes('# artifactshare-managed-pre-push')
  const legacy =
    current.includes('public-development-guard.mjs') &&
    !current.includes('pre-push-review-guard.mjs')
  if (!current || managed || legacy) {
    fs.mkdirSync(hookDirectory, { recursive: true })
    fs.writeFileSync(
      hook,
      `#!/bin/sh
# artifactshare-managed-pre-push
hook_input=$(mktemp "${'${TMPDIR:-/tmp}'}/artifactshare-pre-push.XXXXXX") || exit 1
trap 'rm -f "$hook_input"' EXIT HUP INT TERM
cat > "$hook_input"
node ${JSON.stringify(guard)} --remote "$1" < "$hook_input" || exit $?
node ${JSON.stringify(reviewGuard)} < "$hook_input"
`,
    )
    fs.chmodSync(hook, 0o755)
  } else {
    process.stderr.write(
      `warning: preserving existing pre-push hook at ${hook}; Artifact Share guards were not installed\n`,
    )
  }
} catch (error) {
  if (error?.status !== 128) throw error
}
