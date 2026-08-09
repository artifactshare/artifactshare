#!/usr/bin/env node
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { performance } from 'node:perf_hooks'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, relative, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const schemaVersion = 1

export function aggregateVitestResults(report, root = repoRoot) {
  const suites = Array.isArray(report.testResults) ? report.testResults : []
  const tests = {
    total: report.numTotalTests ?? 0,
    passed: report.numPassedTests ?? 0,
    failed: report.numFailedTests ?? 0,
    pending: report.numPendingTests ?? 0,
    todo: report.numTodoTests ?? 0,
  }
  const suiteResults = suites
    .map((suite) => {
      const duration = Math.max(
        0,
        (suite.endTime ?? 0) - (suite.startTime ?? 0),
      )
      const name = isAbsolute(suite.name)
        ? relative(root, suite.name)
        : suite.name
      return { name, duration_ms: duration, status: suite.status ?? 'unknown' }
    })
    .sort((left, right) => right.duration_ms - left.duration_ms)
    .slice(0, 5)
  return {
    suites: {
      total: report.numTotalTestSuites ?? suites.length,
      passed:
        report.numPassedTestSuites ??
        suites.filter((suite) => suite.status === 'passed').length,
      failed:
        report.numFailedTestSuites ??
        suites.filter((suite) => suite.status === 'failed').length,
    },
    tests,
    slow_suites: suiteResults,
  }
}

function runCommand(command, args, env = {}) {
  return new Promise((resolveResult) => {
    const child = spawn(command, args, {
      cwd: repoRoot,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk
    })
    child.on('error', (error) =>
      resolveResult({ code: 1, stdout, stderr: `${stderr}${error.message}` }),
    )
    child.on('close', (code, signal) =>
      resolveResult({ code: code ?? 1, signal, stdout, stderr }),
    )
  })
}

export async function countRecordedSubprocessLaunches(path) {
  const contents = await readFile(path, 'utf8').catch((error) => {
    if (error?.code === 'ENOENT') return ''
    throw error
  })
  return contents.split('\n').filter(Boolean).length
}

async function main() {
  const tempDirectory = await mkdtemp(
    resolve(tmpdir(), 'artifactshare-cli-tests-'),
  )
  const rawReportPath = resolve(tempDirectory, 'vitest.json')
  const outputDirectory = resolve(repoRoot, '.cli-test-measurements')
  const savedRawReportPath = resolve(outputDirectory, 'vitest.json')
  const resultPath = resolve(outputDirectory, 'latest.json')
  const subprocessCountPath = resolve(tempDirectory, 'subprocess-launches.log')
  try {
    const buildStart = performance.now()
    const build = await runCommand('pnpm', [
      '--filter',
      '@artifactshare/cli',
      'run',
      'build',
    ])
    const buildWallMs = performance.now() - buildStart
    if (build.code !== 0)
      throw new Error(`CLI build failed\n${build.stdout}${build.stderr}`)

    const testStart = performance.now()
    const tests = await runCommand(
      'pnpm',
      [
        '--filter',
        '@artifactshare/cli',
        'exec',
        'vitest',
        'run',
        '--reporter=json',
        `--outputFile=${rawReportPath}`,
      ],
      { ARTIFACTSHARE_TEST_SUBPROCESS_COUNT_FILE: subprocessCountPath },
    )
    const testWallMs = performance.now() - testStart
    if (tests.code !== 0)
      throw new Error(`CLI tests failed\n${tests.stdout}${tests.stderr}`)

    const rawReport = await readFile(rawReportPath, 'utf8')
    const report = JSON.parse(rawReport)
    const aggregate = aggregateVitestResults(report)
    const result = {
      schema_version: schemaVersion,
      timestamp: new Date().toISOString(),
      build_wall_ms: buildWallMs,
      test_wall_ms: testWallMs,
      vitest_raw_json_path: '.cli-test-measurements/vitest.json',
      ...aggregate,
      subprocess_launches:
        await countRecordedSubprocessLaunches(subprocessCountPath),
    }
    await mkdir(outputDirectory, { recursive: true })
    await writeFile(savedRawReportPath, rawReport)
    await writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`)
    process.stdout.write(`result: ${resultPath}\n`)
    process.stdout.write(
      `build: ${buildWallMs.toFixed(1)} ms\ntests: ${testWallMs.toFixed(1)} ms, ${result.tests.passed}/${result.tests.total} passed, ${result.suites.total} suites\n`,
    )
    process.stdout.write(`subprocess launches: ${result.subprocess_launches}\n`)
  } finally {
    await rm(tempDirectory, { recursive: true, force: true })
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    )
    process.exitCode = 1
  })
}
