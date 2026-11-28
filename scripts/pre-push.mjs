import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const remote = process.argv[2] ?? ''

const checks = [
  {
    script: 'format',
    fix: 'formatting differs from oxfmt; run pnpm exec vp fmt -c .oxfmtrc.json, commit, and push again',
  },
  {
    script: 'lint',
    fix: 'pnpm lint failed; fix the findings above, commit, and push again',
  },
]

function prePush() {
  for (const { script, fix } of checks) {
    const result = spawnSync('pnpm', ['-s', script], {
      cwd: root,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: process.platform === 'win32',
    })
    if (result.error?.code === 'ENOENT') {
      process.stderr.write(
        'pre-push: pnpm not found; skipping format and lint\n',
      )
      break
    }
    if (result.status !== 0) {
      process.stderr.write(result.stdout)
      process.stderr.write(result.stderr)
      process.stderr.write(`pre-push: ${fix}\n`)
      return 1
    }
  }
  const guard = spawnSync(
    process.execPath,
    ['scripts/public-development-guard.mjs', '--remote', remote],
    { cwd: root, stdio: 'inherit' },
  )
  return guard.status ?? 1
}

process.exitCode = prePush()
