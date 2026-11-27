// Runs the browser behavior suite with one Vitest process per engine.
// The config runs one file at a time (fileParallelism: false), and inside one
// process that also puts the engines one after another, so a local run took
// the sum of the three engines. Separate processes share no browser, so the
// run takes as long as the slowest engine. CI already gives each engine its
// own runner and passes --project, which runs a single process as before.
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline'

const PROJECTS = ['chromium', 'firefox', 'webkit']
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

if (selectsProject) {
  const { done } = run([...base, ...args])
  process.exit((await done).code)
}

// Each process gets its own browser API port so none waits on another's.
// File filters often name a file only some engines run, so an engine without
// a match passes; the run still fails when no engine found a file.
const runs = PROJECTS.map((project, index) =>
  run(
    [
      ...base,
      `--project=${project}`,
      `--browser.api.port=${63316 + index}`,
      ...(args.length > 0 ? ['--passWithNoTests'] : []),
      ...args,
    ],
    project,
  ),
)
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, () => {
    for (const { child } of runs) child.kill(signal)
  })
const results = await Promise.all(runs.map(({ done }) => done))
for (const { label, code, signal, seconds } of results)
  console.log(
    `${label}: ${code === 0 ? 'passed' : `failed (${signal ?? `exit ${code}`})`} in ${seconds.toFixed(0)}s`,
  )
const failed =
  results.some(({ code }) => code !== 0) ||
  results.every(({ foundNoFiles }) => foundNoFiles)
process.exit(failed ? 1 : 0)
