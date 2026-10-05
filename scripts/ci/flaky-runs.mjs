import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { pathToFileURL } from 'node:url'

export const lanes = [
  ...['chromium', 'firefox', 'webkit'].map((project) => ({
    id: `behavior-browser-${project}`,
    suite: 'behavior-browser',
    project,
  })),
  ...['d1', 'scripts', 'web-unit'].map((suite) => ({
    id: suite,
    suite,
    project: null,
  })),
]

export function validateCount(value) {
  if (!/^(?:[1-9]|[1-4][0-9]|50)$/.test(String(value))) {
    throw new Error('repetitions must be an integer from 1 to 50')
  }
  return Number(value)
}

export function plan(value) {
  const repetitions = validateCount(value)
  return lanes.flatMap((lane) =>
    Array.from({ length: Math.ceil(repetitions / 2) }, (_, index) => ({
      ...lane,
      shard: index + 1,
      runs: Array.from(
        { length: Math.min(2, repetitions - index * 2) },
        (unused, offset) => index * 2 + offset + 1,
      ),
    })),
  )
}

export function suiteCommand(lane, report, root) {
  if (lane.suite === 'scripts')
    return {
      command: process.execPath,
      args: [
        '--test',
        `--test-reporter=${path.join(root, 'scripts/ci/node-test-json-reporter.mjs')}`,
        `--test-reporter-destination=${report}`,
        'scripts/*.test.mjs',
        'packages/contract/generate-surfaces.test.mjs',
        'packages/viewer-kit/scripts/*.test.mjs',
      ],
      env: {},
      format: 'node-jsonl',
    }
  const config =
    lane.suite === 'behavior-browser'
      ? 'vitest.behavior.browser.config.ts'
      : lane.suite === 'd1'
        ? 'app/test/vitest.d1.config.ts'
        : 'vitest.config.ts'
  return {
    command: 'pnpm',
    args: [
      '--filter',
      '@artifactshare/web',
      'exec',
      'vitest',
      '--config',
      config,
      '--run',
      ...(lane.project ? [`--project=${lane.project}`] : []),
      // JSON omits unhandled errors; keep the console reporter for diagnostics.
      '--reporter=default',
      '--reporter=json',
      `--outputFile=${report}`,
    ],
    env: lane.project
      ? { DEBUG: 'pw:browser' }
      : lane.suite === 'web-unit'
        ? { PUBLIC_TEST: '1' }
        : {},
    format: 'vitest-json',
  }
}

export function execute(command, args, options, output) {
  return new Promise((resolve) => {
    const child = spawn(command, args, options)
    child.stdout.on('data', output)
    child.stderr.on('data', output)
    child.on('error', (error) =>
      resolve({ exitCode: null, signal: null, error: error.message }),
    )
    child.on('close', (exitCode, signal) => resolve({ exitCode, signal }))
  })
}

export async function runShard({
  shard,
  repetitions,
  sha,
  results,
  root = process.cwd(),
  executor = execute,
}) {
  repetitions = validateCount(repetitions)
  const expected = plan(repetitions).find(
    (entry) => entry.id === shard.id && entry.shard === shard.shard,
  )
  if (!expected || JSON.stringify(expected.runs) !== JSON.stringify(shard.runs))
    throw new Error('Invalid shard')
  for (const repetition of expected.runs) {
    const directory = path.resolve(results, expected.id, String(repetition))
    fs.mkdirSync(directory, { recursive: true })
    const report = path.join(
      directory,
      expected.suite === 'scripts' ? 'report.jsonl' : 'report.json',
    )
    fs.rmSync(report, { force: true })
    const invocation = suiteCommand(expected, report, root)
    const status = {
      sha,
      repetitions,
      lane: expected.id,
      repetition,
      suite: expected.suite,
      project: expected.project,
      repositoryRoot: root,
      workspaceRoot: path.join(root, 'apps/web'),
      format: invocation.format,
      report: path.basename(report),
      completed: false,
      exitCode: null,
      signal: null,
    }
    const statusPath = path.join(directory, 'status.json')
    fs.writeFileSync(statusPath, JSON.stringify(status))
    fs.writeFileSync(path.join(directory, 'diagnostic.log'), '')
    const output = (chunk) => {
      fs.appendFileSync(path.join(directory, 'diagnostic.log'), chunk)
      process.stdout.write(chunk)
    }
    try {
      Object.assign(
        status,
        await executor(
          invocation.command,
          invocation.args,
          {
            cwd: root,
            env: { ...process.env, ...invocation.env },
            stdio: ['ignore', 'pipe', 'pipe'],
          },
          output,
        ),
      )
      status.completed = true
    } catch (error) {
      status.error = error.message
      output(`${error.message}\n`)
    }
    fs.writeFileSync(statusPath, JSON.stringify(status, null, 2))
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const repetitions = validateCount(process.env.REPETITIONS ?? '20')
  if (process.argv[2] === 'plan') {
    const matrix = JSON.stringify({ include: plan(repetitions) })
    if (process.env.GITHUB_OUTPUT)
      fs.appendFileSync(
        process.env.GITHUB_OUTPUT,
        `matrix=${matrix}\nrepetitions=${repetitions}\n`,
      )
    else console.log(matrix)
  } else if (process.argv[2] === 'run') {
    await runShard({
      shard: JSON.parse(process.env.SHARD),
      repetitions,
      sha: process.env.GITHUB_SHA,
      results: process.env.RESULTS_DIR,
    })
  } else throw new Error('Expected plan or run')
}
