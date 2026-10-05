import fs from 'node:fs'
import path from 'node:path'
import { stripVTControlCharacters } from 'node:util'
import { pathToFileURL } from 'node:url'
import { lanes, validateCount } from './flaky-runs.mjs'

const clean = (value) => stripVTControlCharacters(String(value ?? ''))
export const firstLine = (value) =>
  clean(value)
    .split(/\r?\n/)
    .find((line) => line.trim())
    ?.trim() ?? 'Unknown failure'
const errorText = (error) =>
  typeof error === 'string'
    ? error
    : error?.message || error?.stack || error?.cause?.message || ''

export function normalizeFile(file, status) {
  let result = clean(file || '[suite]').replaceAll('\\', '/')
  const root = status.repositoryRoot?.replaceAll('\\', '/')
  const workspace = status.workspaceRoot?.replaceAll('\\', '/')
  if (root && result.startsWith(`${root}/`))
    result = result.slice(root.length + 1)
  else if (workspace && result.startsWith(`${workspace}/`))
    result = `apps/web/${result.slice(workspace.length + 1)}`
  else if (
    !result.startsWith('/') &&
    !result.startsWith('apps/') &&
    status.suite !== 'scripts' &&
    result !== '[suite]'
  )
    result = `apps/web/${result.replace(/^\.\//, '')}`
  return result
}

const diagnostic = (error, file = '[suite]') => ({
  file,
  testName: file === '[suite]' ? '[suite failure]' : '[file failure]',
  status: 'failed',
  error,
  diagnosticKind: file === '[suite]' ? 'suite' : 'file',
})
const crashPattern = /Browser connection was closed|Failed to run the test/i

export function normalizeReport(text, status, log = '') {
  const rows = []
  if (status.format === 'node-jsonl') {
    const events = text
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    if (events.at(-1)?.type !== 'complete')
      throw new Error('Incomplete Node report')
    for (const event of events.slice(0, -1)) {
      if (
        typeof event.file !== 'string' ||
        typeof event.testName !== 'string' ||
        !['passed', 'failed', 'skipped'].includes(event.status)
      )
        throw new Error('Invalid Node result')
      rows.push({ ...event, error: errorText(event.error) })
    }
  } else if (status.format === 'vitest-json') {
    const report = JSON.parse(text)
    if (!Array.isArray(report.testResults))
      throw new Error('Invalid Vitest report: testResults missing')
    for (const file of report.testResults) {
      if (
        typeof file.name !== 'string' ||
        !Array.isArray(file.assertionResults)
      )
        throw new Error('Invalid Vitest file result')
      for (const assertion of file.assertionResults) {
        if (
          typeof assertion.fullName !== 'string' ||
          ![
            'passed',
            'failed',
            'pending',
            'skipped',
            'todo',
            'disabled',
          ].includes(assertion.status)
        )
          throw new Error('Invalid Vitest assertion')
        rows.push({
          file: file.name,
          testName: assertion.fullName,
          status:
            assertion.status === 'failed'
              ? 'failed'
              : assertion.status === 'passed'
                ? 'passed'
                : 'skipped',
          error: assertion.failureMessages?.map(errorText).join('\n') ?? '',
        })
      }
      const failedAssertions = file.assertionResults.some(
        (item) => item.status === 'failed',
      )
      if (
        (!failedAssertions && (file.status === 'failed' || file.message)) ||
        crashPattern.test(file.message ?? '')
      ) {
        rows.push(
          diagnostic(
            errorText(file.message) || 'File failed without assertion results',
            file.name,
          ),
        )
      }
    }
    if (
      (report.success === false ||
        report.numFailedTests > 0 ||
        report.numFailedTestSuites > 0 ||
        report.numRuntimeErrorTestSuites > 0) &&
      !rows.some((row) => row.status === 'failed')
    )
      rows.push(diagnostic('Vitest reported failure without failed assertions'))
    for (const error of report.unhandledErrors ?? [])
      rows.push(diagnostic(errorText(error)))
  } else throw new Error('Unknown report format')
  // Script tests may print synthetic browser errors while testing this detector.
  const browserLog = status.suite === 'behavior-browser' ? log : ''
  for (const line of clean(browserLog).split('\n')) {
    if (!crashPattern.test(line)) continue
    // Only attribute a diagnostic when the crash line explicitly names a test file.
    const file = line.match(
      /(?:[A-Za-z]:)?[\w$./\\-]+\.(?:test|spec)\.[cm]?[jt]sx?/,
    )?.[0]
    rows.push(diagnostic(line, file))
  }
  return rows.map((row) => ({ ...row, file: normalizeFile(row.file, status) }))
}

export function aggregate({ results, repetitions, sha }) {
  repetitions = validateCount(repetitions)
  const collected = new Map()
  const coverage = []
  for (const lane of lanes) {
    const laneCoverage = {
      suite: lane.suite,
      project: lane.project,
      expected: repetitions,
      completed: 0,
      reports: 0,
    }
    coverage.push(laneCoverage)
    for (let repetition = 1; repetition <= repetitions; repetition++) {
      const directory = path.join(results, lane.id, String(repetition))
      let rows = []
      let status
      try {
        status = JSON.parse(
          fs.readFileSync(path.join(directory, 'status.json'), 'utf8'),
        )
        if (
          status.sha !== sha ||
          status.repetitions !== repetitions ||
          status.lane !== lane.id ||
          status.repetition !== repetition ||
          status.suite !== lane.suite ||
          status.project !== lane.project
        )
          throw new Error('Status identity mismatch')
        if (!status.completed)
          rows.push(diagnostic('Repetition did not complete'))
        else laneCoverage.completed++
        if (!['report.json', 'report.jsonl'].includes(status.report))
          throw new Error('Invalid report path')
        const log = fs.readFileSync(
          path.join(directory, 'diagnostic.log'),
          'utf8',
        )
        rows.push(
          ...normalizeReport(
            fs.readFileSync(path.join(directory, status.report), 'utf8'),
            status,
            log,
          ),
        )
        laneCoverage.reports++
        if (
          (status.exitCode !== 0 || status.signal || status.error) &&
          !rows.some((row) => row.status === 'failed')
        )
          rows.push(
            diagnostic(
              status.error ||
                `Process exited ${status.exitCode}, signal ${status.signal ?? 'none'}`,
            ),
          )
      } catch (error) {
        rows.push(
          diagnostic(
            `Missing or invalid result: ${error.code ?? error.message}`,
          ),
        )
        // Preserve a file-attributed crash even when the reporter never flushed.
        if (status) {
          try {
            const log = fs.readFileSync(
              path.join(directory, 'diagnostic.log'),
              'utf8',
            )
            rows.push(
              ...normalizeReport(
                '{"testResults":[]}',
                { ...status, format: 'vitest-json' },
                log,
              ),
            )
          } catch {
            /* The missing diagnostics are already a suite failure. */
          }
        }
      }
      const perRun = new Map()
      for (const row of rows) {
        const key = JSON.stringify([lane.id, row.file, row.testName])
        const previous = perRun.get(key)
        if (
          !previous ||
          (previous.status !== 'failed' && row.status === 'failed')
        )
          perRun.set(key, row)
      }
      for (const [key, row] of perRun) {
        let entry = collected.get(key)
        if (!entry) {
          entry = {
            suite: lane.suite,
            project: lane.project,
            file: row.file,
            testName: row.testName,
            failureCount: 0,
            repetitions,
            passCount: 0,
            skipCount: 0,
            absentCount: repetitions,
            firstError: null,
            diagnosticKind: row.diagnosticKind ?? null,
          }
          collected.set(key, entry)
        }
        entry.absentCount--
        if (row.status === 'failed') {
          entry.failureCount++
          entry.firstError ??= firstLine(row.error)
        } else if (row.status === 'passed') entry.passCount++
        else entry.skipCount++
      }
    }
  }
  const observations = [...collected.values()].sort((a, b) =>
    [a.suite, a.project ?? '', a.file, a.testName]
      .join('\0')
      .localeCompare(
        [b.suite, b.project ?? '', b.file, b.testName].join('\0'),
        'en',
      ),
  )
  return {
    schemaVersion: 1,
    sha,
    repetitions,
    coverage,
    observations,
    flaky: observations.filter(
      (row) => row.failureCount > 0 && row.failureCount < repetitions,
    ),
    consistentlyFailing: observations.filter(
      (row) => row.failureCount === repetitions,
    ),
  }
}

const cell = (value) =>
  clean(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('|', '&#124;')
    .replace(/[\r\n]/g, ' ')
export function markdown(report) {
  return [
    '# Flaky detector',
    '',
    `Commit: ${report.sha}. Requested repetitions per lane: ${report.repetitions}.`,
    '',
    ...[
      ['Flaky', report.flaky],
      ['Consistently failing', report.consistentlyFailing],
    ].flatMap(([title, rows]) => [
      `## ${title}`,
      '',
      ...(rows.length
        ? [
            '| Suite / project | File | Test | Failures | First error |',
            '| --- | --- | --- | --- | --- |',
            ...rows.map(
              (row) =>
                `| ${cell([row.suite, row.project].filter(Boolean).join(' / '))} | ${cell(row.file)} | ${cell(row.testName)} | ${row.failureCount}/${row.repetitions} | ${cell(row.firstError)} |`,
            ),
          ]
        : ['None.']),
      '',
    ]),
  ].join('\n')
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const [
    results,
    count,
    sha,
    output,
    summary = process.env.GITHUB_STEP_SUMMARY,
  ] = process.argv.slice(2)
  const report = aggregate({ results, repetitions: count, sha })
  fs.mkdirSync(path.dirname(output), { recursive: true })
  fs.writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`)
  if (summary) fs.appendFileSync(summary, markdown(report))
  else console.log(markdown(report))
  process.exitCode =
    report.flaky.length || report.consistentlyFailing.length ? 1 : 0
}
