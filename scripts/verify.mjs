import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')

export const VERIFY_STAGES = [
  { name: 'format', args: ['format'] },
  { name: 'lint', args: ['lint'] },
  { name: 'public:scan', args: ['public:scan', '.'] },
  {
    name: 'check:public-development-guard',
    args: ['check:public-development-guard'],
  },
  { name: 'check:public-hook', args: ['check:public-hook'] },
  { name: 'test:scripts', args: ['test:scripts'] },
]

export function runVerify({
  stages = VERIFY_STAGES,
  run,
  log = (line) => process.stderr.write(`${line}\n`),
  report = (line) => process.stdout.write(`${line}\n`),
} = {}) {
  if (stages.length === 0) throw new Error('verify: no stages to run')
  for (const [index, stage] of stages.entries()) {
    log(`verify: ${stage.name}`)
    const { status, signal, error } = run(stage.args)
    if (!error && status === 0) continue
    const cause = error
      ? `: ${error.message}`
      : signal
        ? ` (killed by ${signal})`
        : ` (exit ${status})`
    const remaining = stages.slice(index + 1).map((s) => s.name)
    const skipped = remaining.length ? `; not run: ${remaining.join(', ')}` : ''
    log(`verify: ${stage.name} failed${cause}${skipped}.`)
    return { stage: stage.name, status: status ?? 1 }
  }
  report(`verify: ok (${stages.map((stage) => stage.name).join(', ')})`)
  return null
}

function pnpm(args) {
  const result = spawnSync('pnpm', args, { cwd: ROOT, stdio: 'inherit' })
  return { status: result.status, signal: result.signal, error: result.error }
}

if (import.meta.main) {
  const args = process.argv.slice(2)
  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write(
      `Usage: pnpm verify\nRuns ${VERIFY_STAGES.map((stage) => stage.name).join(', ')} in order from the repository root and stops at the first failure.\n`,
    )
  } else if (args.length > 0) {
    process.stderr.write(`verify takes no arguments: ${args.join(' ')}\n`)
    process.exitCode = 1
  } else {
    const failure = runVerify({ run: pnpm })
    process.exitCode = failure ? failure.status || 1 : 0
  }
}
