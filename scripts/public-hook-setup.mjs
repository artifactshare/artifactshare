import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const repo = process.cwd()
const recovery = 'node scripts/public-hook-setup.mjs'

function gitPath(...args) {
  return execFileSync('git', ['rev-parse', '--git-path', ...args], {
    cwd: repo,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim()
}

function currentHook() {
  return `#!/bin/sh
# artifactshare-managed-pre-push
repo_root=$(git rev-parse --show-toplevel) || exit 1
if [ -f "$repo_root/package.json" ] && command -v pnpm >/dev/null 2>&1; then
  if ! (cd "$repo_root" && pnpm -s format </dev/null >/dev/null 2>&1); then
    echo "pre-push: formatting differs from oxfmt; run pnpm exec vp fmt -c .oxfmtrc.json, commit, and push again" >&2
    exit 1
  fi
  if ! (cd "$repo_root" && pnpm -s lint </dev/null >&2); then
    echo "pre-push: pnpm lint failed; fix the findings above, commit, and push again" >&2
    exit 1
  fi
fi
if [ -f "$repo_root/scripts/public-development-guard.mjs" ]; then
  node "$repo_root/scripts/public-development-guard.mjs" --remote "$1"
else
  echo "warning: public-development-guard.mjs is missing; skipping boundary guard" >&2
fi
`
}

function classify(current, expected, executable) {
  if (!current) return 'missing'
  if (current === expected && executable) return 'current'
  if (current.includes('# artifactshare-managed-pre-push')) return 'stale'
  if (current.includes('public-development-guard.mjs')) return 'stale'
  return 'custom'
}

try {
  const hookDirectory = path.resolve(repo, gitPath('hooks'))
  const hook = path.join(hookDirectory, 'pre-push')
  const expected = currentHook()
  const current = fs.existsSync(hook) ? fs.readFileSync(hook, 'utf8') : ''
  const executable =
    fs.existsSync(hook) &&
    (process.platform === 'win32' || (fs.statSync(hook).mode & 0o100) !== 0)
  const kind = classify(current, expected, executable)
  if (process.argv.includes('--check')) {
    if (process.env.CI) {
      process.stdout.write('public hook check skipped in CI\n')
    } else if (kind === 'current') {
      process.stdout.write('public hook is current\n')
    } else if (kind === 'custom') {
      process.stderr.write(
        `warning: preserving custom pre-push hook at ${hook}; installer cannot determine whether guards are integrated\n`,
      )
    } else {
      process.stderr.write(
        `public hook is ${kind}; run ${recovery} to install the current managed hook\n`,
      )
      process.exitCode = 1
    }
  } else if (kind === 'missing' || kind === 'legacy' || kind === 'stale') {
    fs.mkdirSync(hookDirectory, { recursive: true })
    fs.writeFileSync(hook, expected)
    fs.chmodSync(hook, 0o755)
  } else if (kind === 'custom') {
    process.stderr.write(
      `warning: preserving existing pre-push hook at ${hook}; Artifact Share guards were not installed\n`,
    )
  }
} catch (error) {
  if (error?.status !== 128) throw error
}
