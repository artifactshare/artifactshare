import fs from 'node:fs'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { execFileSync, spawn } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
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

// Two 20-minute repetitions leave 20 minutes for setup and artifact upload.
export const repetitionTimeoutMs = 20 * 60 * 1000

const ownershipVariable = 'ARTIFACTSHARE_FLAKY_REPETITION'

function processTable(ownership) {
  if (process.platform === 'linux') {
    return fs
      .readdirSync('/proc')
      .filter((name) => /^\d+$/.test(name))
      .flatMap((name) => {
        try {
          const stat = fs.readFileSync(`/proc/${name}/stat`, 'utf8')
          const [state, parent] = stat
            .slice(stat.lastIndexOf(')') + 2)
            .split(' ')
          let owned = false
          if (ownership) {
            try {
              owned = fs
                .readFileSync(`/proc/${name}/environ`, 'utf8')
                .split('\0')
                .includes(`${ownershipVariable}=${ownership}`)
            } catch (error) {
              // Other users' processes and processes exiting during discovery
              // cannot supply our marker. Keep ancestry information regardless.
              if (!['ENOENT', 'ESRCH', 'EACCES', 'EPERM'].includes(error.code))
                throw error
            }
          }
          return [{ pid: Number(name), parent: Number(parent), state, owned }]
        } catch (error) {
          if (error.code === 'ENOENT' || error.code === 'ESRCH') return []
          throw error
        }
      })
  }
  return execFileSync('ps', ['-A', '-o', 'pid=,ppid=,stat='], {
    encoding: 'utf8',
    timeout: 1000,
  })
    .trim()
    .split('\n')
    .map((line) => {
      const [pid, parent, state] = line.trim().split(/\s+/)
      return { pid: Number(pid), parent: Number(parent), state }
    })
}

export async function terminateTree(
  pid,
  { readProcesses = processTable, kill = process.kill, ownership } = {},
) {
  if (!pid) return []
  const diagnostics = []
  const targets = new Set([pid])
  const signal = (target, name) => {
    try {
      kill(target, name)
    } catch (error) {
      if (error.code !== 'ESRCH') diagnostics.push(error.message)
    }
  }
  const deadline = Date.now() + 3000
  try {
    // The inherited marker survives setsid and reparenting, including a parent
    // that exits before our first snapshot. Freeze marked processes as well as
    // descendants before rescanning, then kill the complete discovered tree.
    signal(pid, 'SIGSTOP')
    while (true) {
      const children = readProcesses(ownership).filter(
        (entry) =>
          (entry.owned || targets.has(entry.parent)) && !targets.has(entry.pid),
      )
      for (const child of children) {
        targets.add(child.pid)
        signal(child.pid, 'SIGSTOP')
      }
      if (!children.length) break
      if (Date.now() >= deadline) throw new Error('Process discovery timed out')
    }
  } catch (error) {
    diagnostics.push(error.message)
  } finally {
    for (const target of [...targets].reverse()) signal(target, 'SIGKILL')
    // Also catch any still-associated processes if discovery failed.
    signal(-pid, 'SIGKILL')
  }
  try {
    while (
      readProcesses(ownership).some(
        (entry) => targets.has(entry.pid) && !entry.state.startsWith('Z'),
      )
    ) {
      if (Date.now() >= deadline) throw new Error('Process cleanup timed out')
      await delay(25)
    }
  } catch (error) {
    diagnostics.push(error.message)
  }
  return diagnostics
}

export function execute(command, args, options, output) {
  return new Promise((resolve) => {
    const {
      timeoutMs = repetitionTimeoutMs,
      terminate = terminateTree,
      ...spawnOptions
    } = options
    const ownership = randomUUID()
    const child = spawn(command, args, {
      ...spawnOptions,
      detached: true,
      env: {
        ...(spawnOptions.env ?? process.env),
        [ownershipVariable]: ownership,
      },
    })
    let timedOut = false
    let spawnError
    const finish = (error) =>
      resolve({
        exitCode: child.exitCode,
        signal: child.signalCode,
        timedOut,
        ...(error ? { error } : spawnError ? { error: spawnError } : {}),
      })
    const timer = setTimeout(() => {
      timedOut = true
      // Catch both synchronous throws and rejected termination promises. Close
      // can arrive during cleanup; only this path may finish a timed-out run.
      void (async () => {
        const diagnostics = [`Repetition timed out after ${timeoutMs} ms`]
        try {
          diagnostics.push(...(await terminate(child.pid, { ownership })))
        } catch (error) {
          diagnostics.push(`Termination failed: ${error.message}`)
          try {
            child.kill('SIGKILL')
          } catch (killError) {
            diagnostics.push(
              `Fallback termination failed: ${killError.message}`,
            )
          }
        } finally {
          const error = diagnostics.join('\n')
          try {
            output(`${error}\n`)
          } catch (outputError) {
            diagnostics.push(`Diagnostic output failed: ${outputError.message}`)
          }
          // A failed cleanup must not leave inherited pipes blocking the shard.
          await delay(25)
          child.stdout.destroy()
          child.stderr.destroy()
          finish(diagnostics.join('\n'))
        }
      })()
    }, timeoutMs)
    child.stdout.on('data', output)
    child.stderr.on('data', output)
    child.on('error', (error) => {
      spawnError = error.message
    })
    child.on('close', () => {
      clearTimeout(timer)
      if (!timedOut) finish()
    })
  })
}

export async function runShard({
  shard,
  repetitions,
  sha,
  results,
  root = process.cwd(),
  executor = execute,
  timeoutMs = repetitionTimeoutMs,
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
            timeoutMs,
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
