// `pnpm verify`: the checks that every workflow-script or guard change runs
// before a commit, in order, stopping at the first failure. A shell chain
// joined with `;` starts the next step after a failure; this script exits
// non-zero at the failing stage and names it on one line. The stages are the
// subset of `validate:static` that the scripts-and-guards boundary needs;
// stage new files with `git add` first, since `public:scan` reads the index.
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')

// Cheapest first, so a boundary or manifest finding does not wait for the
// full script suite.
export const VERIFY_STAGES = [
  { name: 'format', args: ['format'] },
  { name: 'lint', args: ['lint'] },
  { name: 'public:scan', args: ['public:scan', '.'] },
  // The boundary manifest check for config/repository-boundary.json.
  {
    name: 'check:public-development-guard',
    args: ['check:public-development-guard'],
  },
  // The installed pre-push guard must match scripts/public-hook-setup.mjs.
  { name: 'check:public-hook', args: ['check:public-hook'] },
  // audit:tests refuses a scripts/*.test.mjs that test:scripts does not run.
  { name: 'audit:tests', args: ['audit:tests'] },
  { name: 'test:scripts', args: ['test:scripts'] },
]

/**
 * Run the stages in order through `run(args)`, which returns
 * `{ status, signal, error }` as spawnSync does. Returns the failing stage
 * with its status, or null when every stage passed.
 */
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
