import fs from 'node:fs'
import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'
import { cell } from './flaky-report.mjs'

export const flakyLabel = 'flaky'
// A green night is one nightly run that covered the lane without this failure.
// A night the detector skipped is no evidence, so the count follows runs.
export const greenRunsToClose = 7
const stateMarker = 'flaky-detector-state'
const statePattern = new RegExp(`<!-- ${stateMarker}: (\\{.*?\\}) -->`, 'su')
const keptSightings = 20
const errorLimit = 240
const titleLimit = 200
const perPage = 100
const pageLimit = 10
const titles = { flaky: 'Flaky', failing: 'Failing every run' }

const oneLine = (value) =>
  String(value ?? '')
    .replace(/\s+/gu, ' ')
    .trim()
const truncate = (value, limit) => {
  const text = oneLine(value)
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text
}
// Display only. A backtick would end the code span, and the exact value stays
// in the state marker, so collapsing it here loses nothing a reader needs.
const inline = (value) => `\`${oneLine(value).replaceAll('`', "'")}\``
const lane = ({ suite, project }) =>
  [suite, project].filter(Boolean).join(' / ')
const laneKey = ({ suite, project }) => `${suite}\u0000${project ?? ''}`

const rowKey = ({ suite, project, file, testName }) =>
  JSON.stringify([suite, project ?? null, file, testName])

export const issueTitle = (kind, row) =>
  truncate(`${titles[kind]}: ${row.testName} (${lane(row)})`, titleLimit)

// Escaping the angle brackets keeps the serialized state out of HTML and makes
// a '-->' inside an error message unable to end the comment early.
const marker = (state) =>
  `<!-- ${stateMarker}: ${JSON.stringify(state)
    .replaceAll('<', '\\u003c')
    .replaceAll('>', '\\u003e')} -->`

export function parseIssueState(body) {
  const found = String(body ?? '').match(statePattern)
  if (!found) return null
  let state
  try {
    state = JSON.parse(found[1])
  } catch {
    return null
  }
  const row = state?.row
  if (
    state?.version !== 1 ||
    typeof row?.suite !== 'string' ||
    typeof row?.file !== 'string' ||
    typeof row?.testName !== 'string'
  )
    return null
  return {
    version: 1,
    row: {
      suite: row.suite,
      project: row.project ?? null,
      file: row.file,
      testName: row.testName,
    },
    greenRuns: Number.isSafeInteger(state.greenRuns) ? state.greenRuns : 0,
    lastRunId: typeof state.lastRunId === 'string' ? state.lastRunId : '',
    sightings: Array.isArray(state.sightings) ? state.sightings : [],
    sightingCount: Number.isSafeInteger(state.sightingCount)
      ? state.sightingCount
      : 0,
  }
}

function renderIssueBody(state, threshold = greenRunsToClose) {
  return [
    marker(state),
    '',
    'The nightly flaky detector repeats each suite and keeps one issue per row',
    'of its report. This issue is written by `scripts/ci/flaky-issues.mjs`.',
    '',
    `- Lane: ${inline(lane(state.row))}`,
    `- File: ${inline(state.row.file)}`,
    `- Test: ${inline(state.row.testName)}`,
    `- Nightly runs that covered the lane without this failure, since the last sighting: ${state.greenRuns} of ${threshold}`,
    '',
    `It closes itself after ${threshold} such runs. A later failure opens a new`,
    'issue, so nothing reopens this one.',
    '',
    `## Sightings (${state.sightingCount})`,
    '',
    '| Nightly (UTC) | Commit | Failures | First error line |',
    '| --- | --- | --- | --- |',
    ...state.sightings.map(
      (sighting) =>
        `| [${cell(sighting.date)}](${sighting.runUrl}) | ${cell(
          String(sighting.sha).slice(0, 8),
        )} | ${sighting.failureCount}/${sighting.repetitions} | ${cell(
          sighting.firstError,
        )} |`,
    ),
    '',
  ].join('\n')
}

export function syncMode({ eventName, ref, defaultBranch }) {
  return eventName === 'schedule' &&
    Boolean(defaultBranch) &&
    ref === `refs/heads/${defaultBranch}`
    ? 'write'
    : 'dry-run'
}

export function planIssueActions({
  report,
  issues,
  run,
  threshold = greenRunsToClose,
}) {
  // A night proves nothing about a lane that did not finish every repetition,
  // so a partly covered lane leaves the counts of its issues alone.
  const covered = new Set(
    (report.coverage ?? [])
      .filter(
        (entry) =>
          entry.expected > 0 &&
          entry.reports === entry.expected &&
          entry.completed === entry.expected,
      )
      .map(laneKey),
  )
  const reported = new Map()
  for (const [kind, rows] of [
    ['flaky', report.flaky ?? []],
    ['failing', report.consistentlyFailing ?? []],
  ])
    for (const row of rows) {
      const key = rowKey(row)
      if (!reported.has(key)) reported.set(key, { kind, row })
    }

  const actions = []
  const tracked = new Map()
  for (const issue of issues) {
    const state = parseIssueState(issue.body)
    if (!state) {
      actions.push({ action: 'skip', reason: 'unmanaged', issue: issue.number })
      continue
    }
    const key = rowKey(state.row)
    if (tracked.has(key)) {
      actions.push({ action: 'skip', reason: 'duplicate', issue: issue.number })
      continue
    }
    tracked.set(key, { issue, state })
  }

  for (const [key, { kind, row }] of reported) {
    const sighting = {
      date: run.date,
      runUrl: run.url,
      sha: run.sha,
      failureCount: row.failureCount,
      repetitions: row.repetitions,
      firstError: truncate(row.firstError || 'Unknown failure', errorLimit),
    }
    const known = tracked.get(key)
    if (!known) {
      const state = {
        version: 1,
        row: {
          suite: row.suite,
          project: row.project ?? null,
          file: row.file,
          testName: row.testName,
        },
        greenRuns: 0,
        lastRunId: run.id,
        sightings: [sighting],
        sightingCount: 1,
      }
      actions.push({
        action: 'create',
        key,
        title: issueTitle(kind, row),
        labels: [flakyLabel],
        body: renderIssueBody(state, threshold),
      })
      continue
    }
    tracked.delete(key)
    if (known.state.lastRunId === run.id) {
      actions.push({
        action: 'skip',
        reason: 'already-recorded',
        issue: known.issue.number,
      })
      continue
    }
    const state = {
      ...known.state,
      greenRuns: 0,
      lastRunId: run.id,
      sightings: [...known.state.sightings, sighting].slice(-keptSightings),
      sightingCount: known.state.sightingCount + 1,
    }
    actions.push({
      action: 'append',
      key,
      issue: known.issue.number,
      body: renderIssueBody(state, threshold),
    })
  }

  for (const [key, { issue, state }] of tracked) {
    if (state.lastRunId === run.id) {
      actions.push({
        action: 'skip',
        reason: 'already-recorded',
        issue: issue.number,
      })
      continue
    }
    if (!covered.has(laneKey(state.row))) {
      actions.push({
        action: 'skip',
        reason: 'lane-not-covered',
        issue: issue.number,
      })
      continue
    }
    const greenRuns = state.greenRuns + 1
    const body = renderIssueBody(
      { ...state, greenRuns, lastRunId: run.id },
      threshold,
    )
    actions.push({
      action: greenRuns >= threshold ? 'close' : 'green',
      key,
      issue: issue.number,
      body,
    })
  }
  return actions
}

async function request({
  repository,
  token,
  fetchImpl = fetch,
  route,
  method = 'GET',
  body,
  allow = [],
}) {
  const response = await fetchImpl(
    new URL(`https://api.github.com/repos/${repository}${route}`),
    {
      method,
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        'x-github-api-version': '2022-11-28',
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
  )
  if (allow.includes(response.status)) return null
  if (!response.ok)
    throw new Error(`GitHub ${method} ${route} failed: ${response.status}`)
  return response.json()
}

export async function listFlakyIssues(options) {
  const issues = []
  for (let page = 1; page <= pageLimit; page++) {
    const batch = await request({
      ...options,
      route: `/issues?labels=${flakyLabel}&state=open&per_page=${perPage}&page=${page}`,
    })
    issues.push(
      ...batch
        .filter((issue) => !issue.pull_request)
        .map(({ number, title, body }) => ({ number, title, body })),
    )
    if (batch.length < perPage) break
  }
  return issues
}

async function ensureLabel(options) {
  const found = await request({
    ...options,
    route: `/labels/${flakyLabel}`,
    allow: [404],
  })
  if (found) return false
  await request({
    ...options,
    method: 'POST',
    route: '/labels',
    body: {
      name: flakyLabel,
      color: 'd93f0b',
      description: 'A row of the nightly flaky detector report',
    },
    allow: [422],
  })
  return true
}

async function applyActions({ actions, ...options }) {
  const applied = []
  for (const action of actions) {
    if (action.action === 'create') {
      const issue = await request({
        ...options,
        method: 'POST',
        route: '/issues',
        body: { title: action.title, body: action.body, labels: action.labels },
      })
      applied.push({ ...action, issue: issue.number })
    } else if (action.action === 'append' || action.action === 'green') {
      await request({
        ...options,
        method: 'PATCH',
        route: `/issues/${action.issue}`,
        body: { body: action.body },
      })
      applied.push(action)
    } else if (action.action === 'close') {
      await request({
        ...options,
        method: 'PATCH',
        route: `/issues/${action.issue}`,
        body: {
          body: action.body,
          state: 'closed',
          state_reason: 'completed',
        },
      })
      applied.push(action)
    }
  }
  return applied
}

export async function syncFlakyIssues({
  repository,
  token,
  fetchImpl = fetch,
  report,
  run,
  mode,
  threshold = greenRunsToClose,
}) {
  assert.match(repository, /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u)
  assert.ok(token, 'GITHUB_TOKEN is required')
  const options = { repository, token, fetchImpl }
  const actions = planIssueActions({
    report,
    issues: await listFlakyIssues(options),
    run,
    threshold,
  })
  if (mode !== 'write') return { mode, actions, applied: [] }
  if (actions.some((action) => action.action === 'create'))
    await ensureLabel(options)
  return {
    mode,
    actions,
    applied: await applyActions({ ...options, actions }),
  }
}

export function summarizeActions({ mode, actions }) {
  const counted = ['create', 'append', 'green', 'close', 'skip'].map(
    (name) =>
      `${name} ${actions.filter((entry) => entry.action === name).length}`,
  )
  return [
    '## Flaky issues',
    '',
    `Mode: ${mode}. ${counted.join(', ')}.`,
    '',
    ...(actions.length
      ? [
          '| Action | Issue | Row or reason |',
          '| --- | --- | --- |',
          ...actions.map(
            (action) =>
              `| ${action.action} | ${action.issue ?? 'new'} | ${cell(
                action.reason ??
                  JSON.parse(action.key).filter(Boolean).join(' / '),
              )} |`,
          ),
        ]
      : ['Nothing to track.']),
    '',
  ].join('\n')
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const [input, summary = process.env.GITHUB_STEP_SUMMARY] =
    process.argv.slice(2)
  let text
  if (!input || !fs.existsSync(input)) {
    // The aggregate step failed before it wrote a report. Its own red step is
    // the signal; leaving every issue untouched keeps the green runs honest.
    text = '## Flaky issues\n\nNo report to read. No issue changed.\n'
  } else {
    const report = JSON.parse(fs.readFileSync(input, 'utf8'))
    if (report.schemaVersion !== 1)
      throw new Error(
        `Unsupported flaky report schema: ${report.schemaVersion}`,
      )
    const repository = process.env.GITHUB_REPOSITORY ?? ''
    const runId = process.env.GITHUB_RUN_ID ?? ''
    text = summarizeActions(
      await syncFlakyIssues({
        repository,
        token: process.env.GITHUB_TOKEN ?? '',
        report,
        run: {
          id: runId,
          url: `${process.env.GITHUB_SERVER_URL ?? 'https://github.com'}/${repository}/actions/runs/${runId}`,
          date: new Date().toISOString().slice(0, 10),
          sha: report.sha,
        },
        mode: syncMode({
          eventName: process.env.GITHUB_EVENT_NAME ?? '',
          ref: process.env.GITHUB_REF ?? '',
          defaultBranch: process.env.DEFAULT_BRANCH ?? '',
        }),
      }),
    )
  }
  process.stdout.write(`${text}\n`)
  if (summary) fs.appendFileSync(summary, text)
}
