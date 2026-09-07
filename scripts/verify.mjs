// `pnpm verify`: the four checks that every workflow-script or documentation
// change runs before a commit, in order, stopping at the first failure. A
// shell chain joined with `;` starts the next step after a failure; this
// script exits non-zero at the failing stage and names it on one line.
import { spawnSync } from 'node:child_process'

export const VERIFY_STAGES = [
  { name: 'format', args: ['format'] },
  { name: 'lint', args: ['lint'] },
  { name: 'test:scripts', args: ['test:scripts'] },
  { name: 'public:scan', args: ['public:scan', '.'] },
]

/**
 * Run the stages in order through `run(args)`, which returns the exit status
 * (or an object with `status` and an optional `error`). Returns the failing
 * stage and its status, or null when every stage passed.
 */
export function runVerify({
  stages = VERIFY_STAGES,
  run,
  log = (line) => process.stderr.write(`${line}\n`),
} = {}) {
  for (const stage of stages) {
    log(`verify: ${stage.name}`)
    const result = run(stage.args)
    const status = typeof result === 'number' ? result : (result?.status ?? 1)
    const error = typeof result === 'number' ? undefined : result?.error
    if (error || status !== 0) {
      const detail = error ? `: ${error.message}` : ''
      log(
        `verify: ${stage.name} failed (exit ${status ?? 'unknown'})${detail}; the later stages did not run.`,
      )
      return { stage: stage.name, status: status ?? 1 }
    }
  }
  log(`verify: ok (${stages.map((stage) => stage.name).join(', ')})`)
  return null
}

function pnpm(args) {
  const result = spawnSync('pnpm', args, { stdio: 'inherit' })
  return { status: result.status ?? 1, error: result.error }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const failure = runVerify({ run: pnpm })
  process.exitCode = failure ? failure.status || 1 : 0
}
