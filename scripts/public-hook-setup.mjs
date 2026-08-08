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
  if (!fs.existsSync(hook)) {
    fs.mkdirSync(hookDirectory, { recursive: true })
    fs.writeFileSync(
      hook,
      `#!/bin/sh\nexec node ${JSON.stringify(guard)} --remote "$1"\n`,
    )
    fs.chmodSync(hook, 0o755)
  } else {
    process.stderr.write(
      `warning: preserving existing pre-push hook at ${hook}; public boundary guard was not installed\n`,
    )
  }
} catch (error) {
  if (error?.status !== 128) throw error
}
