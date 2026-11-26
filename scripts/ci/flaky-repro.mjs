import fs from 'node:fs'
import path from 'node:path'
import { execFileSync, spawn } from 'node:child_process'
import { parseArgs } from 'node:util'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { execute, suiteCommand, validateCount } from './flaky-runs.mjs'
import { firstLine, normalizeReport } from './flaky-report.mjs'

export const repositoryRoot = fileURLToPath(new URL('../..', import.meta.url))
export const projects = ['chromium', 'firefox', 'webkit']
const composeFile = 'compose.playwright.yml'
const pointsFile = 'apps/web/app/test/flaky-repro-points.json'
const testFilePattern = /^apps\/web\/app\/.+\.behavior\.browser\.test\.tsx$/
const maxLoad = 8
// One repetition of the slowest browser behavior file, with a hold, on one CPU.
const defaultTimeoutMs = 600_000

export const holdPoints = (root = repositoryRoot) =>
  JSON.parse(fs.readFileSync(path.join(root, pointsFile), 'utf8'))

export const usage = `pnpm test:flaky-repro -- --file <path> --project <${projects.join('|')}> [options]

Repeat one browser behavior test and report what the repetitions did. Each
repetition is its own Vitest process, as the nightly detector and the changed
browser repetitions job run them.

  --file <path>          The browser behavior test file, from the issue.
  --project <name>       ${projects.join(', ')}.
  --test <name>          One test in the file, matched literally.
  --repeat <1-50>        Repetitions. Default 1.
  --delay <point>=<ms>   Hold the scenario at <point>. Repeatable. --list prints
                         the points. Without it, nothing is held or injected.
  --cpus <n>             Limit the container to n CPUs (docker runner only).
  --load <0-${maxLoad}>           Busy loops to run beside the repetitions.
  --results <dir>        Where reports, captures and summary.json go.
                         Default .flaky-repro/<timestamp>.
  --timeout <ms>         Per repetition. Default ${defaultTimeoutMs}.
  --volume-prefix <name> Container volumes to reuse between runs.
  --no-docker            Run on this machine instead of the pinned image.
  --list                 Print the hold points and what each one holds.

Prints the summary as JSON on stdout and progress on stderr. It exits 0 when
the summary can be read as a result, including when repetitions failed, and 1
when nothing can be concluded: no test ran, or a configured hold never held.`

// Command-line misuse reads as one line in a routine's log; anything else
// keeps its stack, because it is a defect in this runner.
export class UsageError extends Error {
  constructor(message) {
    super(message)
    this.name = 'UsageError'
  }
}
const misuse = (message) => {
  throw new UsageError(message)
}

const slug = () => new Date().toISOString().replaceAll(/[:.]/gu, '-')
const inside = (root, candidate) => {
  const relative = path
    .relative(root, path.resolve(root, candidate))
    .split(path.sep)
    .join('/')
  if (!relative || relative.startsWith('../'))
    misuse(`Path must stay inside the repository: ${candidate}`)
  return relative
}

export function parseOptions(argv, { root = repositoryRoot } = {}) {
  let values
  try {
    values = parseArgs({
      args: argv,
      options: {
        file: { type: 'string' },
        test: { type: 'string' },
        project: { type: 'string' },
        repeat: { type: 'string', default: '1' },
        cpus: { type: 'string' },
        load: { type: 'string', default: '0' },
        delay: { type: 'string', multiple: true, default: [] },
        results: { type: 'string' },
        timeout: { type: 'string', default: String(defaultTimeoutMs) },
        'volume-prefix': {
          type: 'string',
          default: 'artifactshare-playwright',
        },
        'no-docker': { type: 'boolean', default: false },
        list: { type: 'boolean', default: false },
        help: { type: 'boolean', default: false },
      },
      allowPositionals: false,
    }).values
  } catch (error) {
    misuse(error.message)
  }
  if (values.help) return { mode: 'help' }
  if (values.list) return { mode: 'list' }
  if (!values.file) misuse('--file is required')
  const file = inside(root, values.file)
  if (!testFilePattern.test(file))
    misuse(`--file must be a browser behavior test: ${file}`)
  if (!fs.existsSync(path.join(root, file)))
    misuse(`--file does not exist: ${file}`)
  if (!projects.includes(values.project))
    misuse(`--project must be one of ${projects.join(', ')}`)
  let repeat
  try {
    repeat = validateCount(values.repeat)
  } catch (error) {
    misuse(`--repeat: ${error.message}`)
  }
  if (!/^\d+$/u.test(values.load) || Number(values.load) > maxLoad)
    misuse(`--load must be a whole number of busy loops, 0 to ${maxLoad}`)
  if (values.cpus !== undefined) {
    if (!/^\d+(?:\.\d+)?$/u.test(values.cpus) || Number(values.cpus) <= 0)
      misuse('--cpus must be a positive number of CPUs')
    if (values['no-docker'])
      misuse('--cpus limits the docker runner; it cannot limit --no-docker')
  }
  if (!/^\d+$/u.test(values.timeout) || Number(values.timeout) <= 0)
    misuse('--timeout must be whole milliseconds')
  const known = holdPoints(root)
  const delays = new Map()
  for (const entry of values.delay) {
    const found = /^([^=]+)=(\d+)$/u.exec(entry)
    if (!found) misuse(`--delay must be <point>=<ms>: ${entry}`)
    const [, point, ms] = found
    if (!Object.hasOwn(known, point))
      misuse(`Unknown hold point ${point}; --list prints the known points`)
    if (Number(ms) <= 0) misuse(`--delay for ${point} must be more than 0 ms`)
    delays.set(point, Number(ms))
  }
  return {
    mode: 'run',
    file,
    test: values.test ?? null,
    project: values.project,
    repeat,
    cpus: values.cpus ?? null,
    load: Number(values.load),
    delays,
    timeoutMs: Number(values.timeout),
    docker: !values['no-docker'],
    volumePrefix: values['volume-prefix'],
    results: values.results
      ? inside(root, values.results)
      : `.flaky-repro/${slug()}`,
  }
}

const quote = (value) => `'${String(value).replaceAll("'", `'\\''`)}'`
const escapeForRegExp = (value) =>
  value.replaceAll(/[.*+?^${}()|[\]\\]/gu, '\\$&')

export function delayEnvironment(delays) {
  return delays.size
    ? [...delays].map(([point, ms]) => `${point}=${ms}`).join(',')
    : ''
}

export function vitestInvocation(options, { root = repositoryRoot, report }) {
  const invocation = suiteCommand(
    { suite: 'behavior-browser', project: options.project },
    report,
    root,
  )
  if (options.test)
    invocation.args.push('--testNamePattern', escapeForRegExp(options.test))
  invocation.args.push(path.resolve(root, options.file))
  return invocation
}

// The image and the toolchain stay pinned in one place: the compose file the
// visual suite already runs. A second pin here would drift from it.
export function pinnedRuntime(source) {
  const images = [
    ...new Set([...source.matchAll(/^\s*image:\s*(\S+)$/gmu)].map((m) => m[1])),
  ]
  const toolchains = [
    ...new Set(
      [
        ...source.matchAll(
          /npm install --global --prefix \/opt\/toolchain (node@\S+) (pnpm@\S+)/gu,
        ),
      ].map((found) => `${found[1]} ${found[2]}`),
    ),
  ]
  if (images.length !== 1 || toolchains.length !== 1)
    throw new Error(
      `${composeFile} must pin exactly one Playwright image and one toolchain`,
    )
  return { image: images[0], toolchain: toolchains[0] }
}

function proxyEnvironment(environment) {
  const names = [
    'HTTPS_PROXY',
    'https_proxy',
    'HTTP_PROXY',
    'http_proxy',
    'NO_PROXY',
    'no_proxy',
  ]
  return names.flatMap((name) =>
    environment[name] ? [[name, environment[name]]] : [],
  )
}

export function dockerInvocation(
  options,
  { root = repositoryRoot, runtime, name, environment = process.env },
) {
  const prefix = options.volumePrefix
  const args = [
    'run',
    '--rm',
    `--name=${name}`,
    // The browser needs the host's shared memory, and the run reaches a
    // loopback package proxy when one is configured for this machine.
    '--ipc=host',
    '--network=host',
    '--workdir=/workspace',
    '--volume',
    `${root}:/workspace`,
    '--volume',
    `${prefix}-toolchain:/opt/toolchain`,
    '--volume',
    `${prefix}-pnpm-store:/pnpm/store`,
    '--volume',
    `${prefix}-root-node-modules:/workspace/node_modules`,
    '--volume',
    `${prefix}-web-node-modules:/workspace/apps/web/node_modules`,
    '--volume',
    `${prefix}-cli-node-modules:/workspace/packages/cli/node_modules`,
    '--volume',
    `${prefix}-fixtures-node-modules:/workspace/tools/static-site-fixtures/node_modules`,
    '--env',
    'CI=true',
    '--env',
    'HOME=/root',
    '--env',
    'PLAYWRIGHT_BROWSERS_PATH=/ms-playwright',
  ]
  if (options.cpus) args.push(`--cpus=${options.cpus}`)
  for (const [variable, value] of proxyEnvironment(environment))
    args.push('--env', `${variable}=${value}`)
  const certificates = environment.NODE_EXTRA_CA_CERTS
  if (certificates) {
    args.push('--volume', `${path.dirname(certificates)}:/certificates:ro`)
    args.push(
      '--env',
      `NODE_EXTRA_CA_CERTS=/certificates/${path.basename(certificates)}`,
    )
  }
  const inner = [
    '--no-docker',
    '--file',
    options.file,
    '--project',
    options.project,
    '--repeat',
    String(options.repeat),
    '--results',
    options.results,
    '--timeout',
    String(options.timeoutMs),
    ...(options.test ? ['--test', options.test] : []),
    ...[...options.delays].flatMap(([point, ms]) => [
      '--delay',
      `${point}=${ms}`,
    ]),
  ]
  args.push(
    runtime.image,
    'bash',
    '-lc',
    [
      'set -euo pipefail',
      'export PATH=/opt/toolchain/bin:$PATH',
      `command -v pnpm >/dev/null || npm install --global --prefix /opt/toolchain ${runtime.toolchain}`,
      'pnpm config set store-dir /pnpm/store',
      'pnpm install --frozen-lockfile --ignore-scripts',
      `node scripts/ci/flaky-repro.mjs ${inner.map(quote).join(' ')}`,
    ].join('\n'),
  )
  return { command: 'docker', args }
}

// Paths stay relative to the repository, so a summary a container wrote names
// the same files on the machine that reads it.
const collected = (directory, root) => ({
  captures: fs
    .readdirSync(directory)
    .filter((entry) => entry.startsWith('state-'))
    .sort()
    .map((entry) =>
      path
        .relative(root, path.join(directory, entry))
        .split(path.sep)
        .join('/'),
    ),
  // A line a crash left half written counts as no holds, which the summary
  // then reports as a hold that never ran rather than as a reproduction.
  holds: fs.existsSync(path.join(directory, 'holds.jsonl'))
    ? fs
        .readFileSync(path.join(directory, 'holds.jsonl'), 'utf8')
        .split('\n')
        .filter(Boolean)
        .flatMap((line) => {
          try {
            return [JSON.parse(line)]
          } catch {
            return []
          }
        })
    : [],
})

export function readRun({ directory, run, options, root = repositoryRoot }) {
  const result = { run, ...collected(directory, root) }
  let rows
  try {
    rows = normalizeReport(
      fs.readFileSync(path.join(directory, 'report.json'), 'utf8'),
      {
        format: 'vitest-structured',
        project: options.project,
        suite: 'behavior-browser',
        repositoryRoot: root,
        workspaceRoot: path.join(root, 'apps/web'),
      },
    )
  } catch (error) {
    return { ...result, incomplete: firstLine(error.message) }
  }
  // A suite-level diagnostic belongs to no file and still breaks this run.
  const own = rows.filter(
    (row) => row.file === options.file || row.file === '[suite]',
  )
  const failed = own.filter((row) => row.status === 'failed')
  return {
    ...result,
    observed: own.filter(
      (row) => !row.diagnosticKind && row.status !== 'skipped',
    ).length,
    failed: failed.length,
    error: failed.length ? firstLine(failed[0].error) : null,
    others: [
      ...new Set(
        rows
          .filter(
            (row) =>
              !own.includes(row) &&
              !row.diagnosticKind &&
              row.status !== 'skipped',
          )
          .map((row) => row.file),
      ),
    ],
  }
}

export function summarize(options, runs, { where }) {
  const holds = Object.fromEntries(
    [...options.delays.keys()].map((point) => [point, 0]),
  )
  for (const run of runs)
    for (const recorded of run.holds)
      for (const [point, count] of Object.entries(recorded))
        if (typeof count === 'number')
          holds[point] = (holds[point] ?? 0) + count
  const failed = runs.filter((run) => run.failed)
  const incomplete = runs.filter((run) => run.incomplete)
  return {
    file: options.file,
    test: options.test,
    project: options.project,
    where,
    repeat: options.repeat,
    cpus: options.cpus,
    load: options.load,
    delays: Object.fromEntries(options.delays),
    runs: runs.length,
    failures: failed.length,
    failedRuns: failed.map((run) => run.run),
    incompleteRuns: incomplete.map((run) => run.run),
    observed: runs.reduce((total, run) => total + (run.observed ?? 0), 0),
    firstError: failed[0]?.error ?? null,
    firstIncomplete: incomplete[0]?.incomplete ?? null,
    holds,
    captures: runs.flatMap((run) => run.captures),
    otherModules: [...new Set(runs.flatMap((run) => run.others ?? []))],
    durationsMs: runs.map((run) => run.durationMs),
    results: options.results,
  }
}

// A summary nothing can be concluded from is a runner failure, not a result:
// the test must have run, and a configured hold must have held something.
export function unusable(summary) {
  if (!summary.observed)
    return `No test ran for ${summary.file} in ${summary.project}; check --file and --test`
  const inert = Object.entries(summary.holds).filter(([, count]) => !count)
  if (inert.length)
    return `Hold ${inert.map(([point]) => point).join(', ')} never ran, so the delay proved nothing`
  return null
}

function startLoad(count) {
  const children = Array.from({ length: count }, () =>
    spawn(process.execPath, ['-e', 'for (;;);'], { stdio: 'ignore' }),
  )
  return () => {
    for (const child of children) child.kill('SIGKILL')
  }
}

const note = (message) => process.stderr.write(`${message}\n`)

async function runLocally(options, root) {
  const runs = []
  for (let run = 1; run <= options.repeat; run++) {
    const directory = path.resolve(root, options.results, String(run))
    fs.mkdirSync(directory, { recursive: true })
    const report = path.join(directory, 'report.json')
    const invocation = vitestInvocation(options, { root, report })
    const log = path.join(directory, 'diagnostic.log')
    fs.writeFileSync(log, '')
    const started = Date.now()
    const status = await execute(
      invocation.command,
      invocation.args,
      {
        cwd: root,
        timeoutMs: options.timeoutMs,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          ...invocation.env,
          FLAKY_REPRO_DIR: directory,
          FLAKY_REPRO_DELAYS: delayEnvironment(options.delays),
        },
      },
      (chunk) => fs.appendFileSync(log, chunk),
    )
    const result = {
      ...readRun({ directory, run, options, root }),
      durationMs: Date.now() - started,
      exitCode: status.exitCode,
    }
    if (status.timedOut)
      result.incomplete = `Timed out after ${options.timeoutMs} ms`
    runs.push(result)
    note(
      `run ${run}/${options.repeat}: ${
        result.incomplete
          ? `incomplete (${result.incomplete})`
          : `${result.failed} failed of ${result.observed} observed`
      } in ${Math.round(result.durationMs / 1000)}s`,
    )
  }
  return runs
}

// The container is given neither limit as an argument, so its summary takes
// the conditions back from the invocation that applied them.
export const dockerSummary = (summary, options) => ({
  ...summary,
  where: 'docker',
  cpus: options.cpus,
  load: options.load,
})

async function runInDocker(options, root) {
  const runtime = pinnedRuntime(
    fs.readFileSync(path.join(root, composeFile), 'utf8'),
  )
  const name = `flaky-repro-${process.pid}-${Date.now()}`
  const invocation = dockerInvocation(options, { root, runtime, name })
  // The image installs the toolchain and the workspace once for every
  // repetition the run makes inside it.
  const timeoutMs = options.timeoutMs * options.repeat + 900_000
  const log = path.resolve(root, options.results, 'docker.log')
  fs.writeFileSync(log, '')
  const status = await execute(
    invocation.command,
    invocation.args,
    { cwd: root, timeoutMs, stdio: ['ignore', 'pipe', 'pipe'] },
    (chunk) => {
      fs.appendFileSync(log, chunk)
      process.stderr.write(chunk)
    },
  )
  if (status.timedOut)
    try {
      execFileSync('docker', ['kill', name], { stdio: 'ignore' })
    } catch {
      note(`Could not stop container ${name}`)
    }
  const summaryFile = path.resolve(root, options.results, 'summary.json')
  if (!fs.existsSync(summaryFile))
    throw new Error(
      `The container wrote no summary; see ${path.relative(root, log)}`,
    )
  return JSON.parse(fs.readFileSync(summaryFile, 'utf8'))
}

export async function main(argv, { root = repositoryRoot } = {}) {
  const options = parseOptions(argv, { root })
  if (options.mode === 'help') {
    process.stdout.write(`${usage}\n`)
    return 0
  }
  if (options.mode === 'list') {
    for (const [point, description] of Object.entries(holdPoints(root)))
      process.stdout.write(`${point}\n  ${description}\n`)
    return 0
  }
  fs.mkdirSync(path.resolve(root, options.results), { recursive: true })
  const stopLoad = startLoad(options.load)
  let summary
  try {
    summary = options.docker
      ? dockerSummary(await runInDocker(options, root), options)
      : summarize(options, await runLocally(options, root), { where: 'local' })
  } finally {
    stopLoad()
  }
  fs.writeFileSync(
    path.resolve(root, options.results, 'summary.json'),
    `${JSON.stringify(summary, null, 2)}\n`,
  )
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`)
  const refusal = unusable(summary)
  if (refusal) {
    note(refusal)
    return 1
  }
  return 0
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    process.exitCode = await main(process.argv.slice(2))
  } catch (error) {
    if (!(error instanceof UsageError)) throw error
    note(`${error.message}\nRun with --help for the options.`)
    process.exitCode = 1
  }
}
