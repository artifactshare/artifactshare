// Runs the browser behavior suite with one Vitest process per engine.
// The config runs one file at a time (fileParallelism: false), and inside one
// process that also puts the engines one after another, so a local run took
// the sum of the engines. Separate processes share no browser, so the
// run takes as long as the slowest engine. CI already gives each engine its
// own runner and passes --project, which runs a single process as before.
// Firefox runs only in the nightly Flaky detector; pass --project=firefox to
// run it here.
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline'

const PROJECTS = ['chromium', 'webkit']
const vitest = join(
  dirname(createRequire(import.meta.url).resolve('vitest/package.json')),
  'vitest.mjs',
)
const base = ['--config', 'vitest.behavior.browser.config.ts', '--run']
const args = process.argv.slice(2)
const selectsProject = args.some(
  (arg) => arg === '--project' || arg.startsWith('--project='),
)

function run(argv, label) {
  const started = Date.now()
  let foundNoFiles = false
  const child = spawn(process.execPath, [vitest, ...argv], {
    stdio: label ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    env:
      label && process.stdout.isTTY
        ? { ...process.env, FORCE_COLOR: '1' }
        : process.env,
  })
  if (label) {
    for (const [stream, out] of [
      [child.stdout, process.stdout],
      [child.stderr, process.stderr],
    ])
      createInterface({ input: stream }).on('line', (line) => {
        if (line.includes('No test files found')) foundNoFiles = true
        out.write(`[${label}] ${line}\n`)
      })
  }
  return {
    child,
    done: new Promise((resolve) =>
      child.on('close', (code, signal) =>
        resolve({
          label,
          code: code ?? 1,
          signal,
          foundNoFiles,
          seconds: (Date.now() - started) / 1000,
        }),
      ),
    ),
  }
}

const runs = []
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, () => {
    for (const { child } of runs) child.kill(signal)
  })

if (selectsProject) {
  runs.push(run([...base, ...args]))
  process.exit((await runs[0].done).code)
}

// Each process gets its own browser API port so none waits on another's.
// File filters often name a file only some engines run, so an engine without
// a match passes; the run still fails when no engine found a file.
runs.push(
  ...PROJECTS.map((project, index) =>
    run(
      [
        ...base,
        `--project=${project}`,
        `--api.port=${63316 + index}`,
        ...(args.length > 0 ? ['--passWithNoTests'] : []),
        ...args,
      ],
      project,
    ),
  ),
)
const results = await Promise.all(runs.map(({ done }) => done))
for (const { label, code, signal, seconds } of results)
  console.log(
    `${label}: ${code === 0 ? 'passed' : `failed (${signal ?? `exit ${code}`})`} in ${seconds.toFixed(0)}s`,
  )
if (results.every(({ foundNoFiles }) => foundNoFiles)) {
  console.error('No engine found a test file matching the filter.')
  process.exit(1)
}
process.exit(results.some(({ code }) => code !== 0) ? 1 : 0)
