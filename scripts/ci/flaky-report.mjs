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
const unhandledDiagnostic = (error) => ({
  ...diagnostic(error),
  testName: '[unhandled error]',
  diagnosticKind: 'unhandled',
})

export function normalizeReport(text, status) {
  const rows = []
  if (status.format === 'node-jsonl') {
    let complete = false
    for (const line of text.split('\n')) {
      if (!line.trim()) continue
      try {
        const event = JSON.parse(line)
        if (complete) throw new Error('Result after Node completion')
        if (event.type === 'complete') {
          complete = true
          continue
        }
        if (
          typeof event.file !== 'string' ||
          typeof event.testName !== 'string' ||
          !['passed', 'failed', 'skipped'].includes(event.status)
        )
          throw new Error('Invalid Node result')
        rows.push({ ...event, error: errorText(event.error) })
      } catch (error) {
        rows.push(diagnostic(`Invalid Node result: ${error.message}`))
      }
    }
    if (!complete) rows.push(diagnostic('Incomplete Node report'))
  } else if (status.format === 'vitest-structured') {
    const report = JSON.parse(text)
    if (
      report.schemaVersion !== 1 ||
      !Array.isArray(report.modules) ||
      !Array.isArray(report.unhandledErrors) ||
      !['passed', 'failed', 'interrupted'].includes(report.reason)
    )
      throw new Error('Invalid structured Vitest report')
    const validateEntity = (entity, named = false) => {
      if (
        !['passed', 'failed', 'skipped', 'pending', 'queued'].includes(
          entity.state,
        ) ||
        !Array.isArray(entity.errors) ||
        (named &&
          (!Array.isArray(entity.namePath) ||
            !entity.namePath.length ||
            !entity.namePath.every((name) => typeof name === 'string')))
      )
        throw new Error('Invalid Vitest entity')
    }
    for (const module of report.modules) {
      validateEntity(module)
      if (
        typeof module.moduleId !== 'string' ||
        module.project !== (status.project ?? null) ||
        !Array.isArray(module.tests) ||
        !Array.isArray(module.suites)
      )
        throw new Error('Invalid Vitest module identity')
      const moduleRows = []
      for (const test of module.tests) {
        validateEntity(test, true)
        moduleRows.push({
          file: module.moduleId,
          namePath: test.namePath,
          testName: test.namePath.join(' > '),
          status:
            test.state === 'pending' || test.state === 'queued'
              ? 'absent'
              : test.state,
          error: test.errors.map(errorText).join('\n'),
        })
      }
      for (const suite of module.suites) {
        validateEntity(suite, true)
        if (suite.errors.length)
          moduleRows.push({
            ...diagnostic(
              suite.errors.map(errorText).join('\n'),
              module.moduleId,
            ),
            namePath: suite.namePath,
            testName: `[suite failure] ${suite.namePath.join(' > ')}`,
            diagnosticKind: 'suite',
          })
      }
      if (
        module.errors.length ||
        (module.state === 'failed' &&
          !moduleRows.some((row) => row.status === 'failed'))
      )
        moduleRows.push(
          diagnostic(
            module.errors.map(errorText).join('\n') ||
              'Module failed without assertion results',
            module.moduleId,
          ),
        )
      rows.push(...moduleRows)
    }
    for (const unhandled of report.unhandledErrors) {
      if (
        !unhandled.error ||
        (unhandled.moduleId !== null && typeof unhandled.moduleId !== 'string')
      )
        throw new Error('Invalid Vitest unhandled error')
      const error = errorText(unhandled.error)
      rows.push(unhandledDiagnostic(error))
      if (unhandled.moduleId) rows.push(diagnostic(error, unhandled.moduleId))
    }
    if (
      report.reason === 'interrupted' ||
      report.modules.some((module) =>
        ['pending', 'queued'].includes(module.state),
      ) ||
      rows.some((row) => row.status === 'absent')
    )
      rows.push(diagnostic('Vitest run incomplete'))
    if (
      report.reason === 'failed' &&
      !rows.some((row) => row.status === 'failed')
    )
      rows.push(diagnostic('Vitest reported failure without results'))
  } else throw new Error('Unknown report format')
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
        if (status.timedOut || status.error || status.signal)
          rows.push(
            diagnostic(
              status.error ||
                (status.timedOut
                  ? 'Repetition timed out'
                  : `Process terminated by ${status.signal}`),
            ),
          )
        if (!status.completed)
          rows.push(diagnostic('Repetition did not complete'))
        else laneCoverage.completed++
        if (!['report.json', 'report.jsonl'].includes(status.report))
          throw new Error('Invalid report path')
        rows.push(
          ...normalizeReport(
            fs.readFileSync(path.join(directory, status.report), 'utf8'),
            status,
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
        let tail = ''
        try {
          tail = clean(
            fs.readFileSync(path.join(directory, 'diagnostic.log'), 'utf8'),
          )
            .trim()
            .split('\n')
            .slice(-10)
            .join(' / ')
        } catch {
          /* Missing logs are covered by this infrastructure diagnostic. */
        }
        rows.push(
          diagnostic(
            `Missing or invalid result: ${error.code ?? error.message}; process exited ${status?.exitCode ?? 'unknown'}, signal ${status?.signal ?? 'none'}${tail ? `; log tail: ${tail}` : ''}`,
          ),
        )
      }
      const perRun = new Map()
      for (const row of rows) {
        const key = JSON.stringify([
          lane.id,
          row.file,
          row.diagnosticKind ?? null,
          row.namePath ?? row.testName,
        ])
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
            ...(row.namePath ? { namePath: row.namePath } : {}),
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
        if (row.status === 'absent') continue
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
