import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { spawnSync } from 'node:child_process'
import {
  flakyLabel,
  greenRunsToClose,
  issueTitle,
  listFlakyIssues,
  parseIssueState,
  planIssueActions,
  summarizeActions,
  syncFlakyIssues,
  syncMode,
} from './ci/flaky-issues.mjs'

const browserLane = { suite: 'behavior-browser', project: 'firefox' }
const scriptsLane = { suite: 'scripts', project: null }
const sha = 'e74d2d24e74d2d24e74d2d24e74d2d24e74d2d24'

const row = (overrides = {}) => ({
  ...browserLane,
  file: 'apps/web/app/lib/preview-security.behavior.browser.test.tsx',
  testName: 'interactive documents can be operated and annotated per screen',
  failureCount: 1,
  repetitions: 20,
  firstError: 'locator.waitFor: Timeout 30000ms exceeded.',
  ...overrides,
})

const covered = (lanes = [browserLane, scriptsLane], changes = {}) =>
  lanes.map((entry) => ({
    ...entry,
    expected: 20,
    completed: 20,
    reports: 20,
    ...changes,
  }))

const reportOf = ({ flaky = [], failing = [], coverage } = {}) => ({
  schemaVersion: 1,
  sha,
  repetitions: 20,
  coverage: coverage ?? covered(),
  flaky,
  consistentlyFailing: failing,
})

const nightly = (night) => ({
  id: `4580611910${night}`,
  url: `https://github.com/artifactshare/artifactshare/actions/runs/4580611910${night}`,
  date: `2026-11-${String(night).padStart(2, '0')}`,
  sha,
})

const openIssue = (action, number = 41) => ({
  number,
  title: action.title ?? 'a title someone else chose',
  body: action.body,
})

const plan = (options) => planIssueActions({ run: nightly(1), ...options })

test('a first sighting opens one issue for each reported row', () => {
  const failing = row({
    ...scriptsLane,
    file: 'scripts/verify.test.mjs',
    testName: 'runs every stage',
    failureCount: 20,
    firstError: 'Missing or invalid result: ENOENT',
  })
  const actions = plan({
    report: reportOf({ flaky: [row()], failing: [failing] }),
    issues: [],
  })
  assert.deepEqual(
    actions.map((action) => action.action),
    ['create', 'create'],
  )
  assert.deepEqual(actions[0].labels, [flakyLabel])
  assert.equal(
    actions[0].title,
    'Flaky: interactive documents can be operated and annotated per screen (behavior-browser / firefox)',
  )
  assert.equal(
    actions[1].title,
    'Failing every run: runs every stage (scripts)',
  )
  assert.match(actions[0].body, /1\/20/u)
  assert.match(actions[0].body, /locator\.waitFor: Timeout 30000ms exceeded\./u)
  assert.match(
    actions[0].body,
    new RegExp(`since the last sighting: 0 of ${greenRunsToClose}`, 'u'),
  )
  assert.deepEqual(parseIssueState(actions[0].body).row, {
    suite: 'behavior-browser',
    project: 'firefox',
    file: 'apps/web/app/lib/preview-security.behavior.browser.test.tsx',
    testName: 'interactive documents can be operated and annotated per screen',
  })
})

test('a later sighting adds a row to the issue that already tracks it', () => {
  const [created] = plan({ report: reportOf({ flaky: [row()] }), issues: [] })
  const actions = planIssueActions({
    report: reportOf({ flaky: [row({ failureCount: 3 })] }),
    issues: [openIssue(created)],
    run: nightly(2),
  })
  assert.deepEqual(actions, [
    { action: 'append', key: actions[0].key, issue: 41, body: actions[0].body },
  ])
  const state = parseIssueState(actions[0].body)
  assert.equal(state.sightingCount, 2)
  assert.deepEqual(
    state.sightings.map((sighting) => sighting.failureCount),
    [1, 3],
  )
  assert.match(actions[0].body, /## Sightings \(2\)/u)
})

test('a renamed title does not open a second issue', () => {
  const [created] = plan({ report: reportOf({ flaky: [row()] }), issues: [] })
  const actions = planIssueActions({
    report: reportOf({ flaky: [row()] }),
    issues: [{ ...openIssue(created), title: 'Flaky: renamed by hand' }],
    run: nightly(2),
  })
  assert.deepEqual(
    actions.map((action) => action.action),
    ['append'],
  )
})

test('a reported row whose lane went quiet counts one green run', () => {
  const [created] = plan({ report: reportOf({ flaky: [row()] }), issues: [] })
  const [action] = planIssueActions({
    report: reportOf(),
    issues: [openIssue(created)],
    run: nightly(2),
  })
  assert.equal(action.action, 'green')
  assert.equal(parseIssueState(action.body).greenRuns, 1)
})

test('a lane that did not finish its repetitions counts no green run', () => {
  const [created] = plan({ report: reportOf({ flaky: [row()] }), issues: [] })
  for (const changes of [{ reports: 19 }, { completed: 19 }, { expected: 0 }]) {
    const [action] = planIssueActions({
      report: reportOf({ coverage: covered([browserLane], changes) }),
      issues: [openIssue(created)],
      run: nightly(2),
    })
    assert.deepEqual(
      action,
      { action: 'skip', reason: 'lane-not-covered', issue: 41 },
      JSON.stringify(changes),
    )
  }
})

test('a lane missing from the report counts no green run', () => {
  const [created] = plan({ report: reportOf({ flaky: [row()] }), issues: [] })
  const [action] = planIssueActions({
    report: reportOf({ coverage: covered([scriptsLane]) }),
    issues: [openIssue(created)],
    run: nightly(2),
  })
  assert.equal(action.reason, 'lane-not-covered')
})

test(`an issue closes after ${greenRunsToClose} green runs, and not before`, () => {
  const [created] = plan({ report: reportOf({ flaky: [row()] }), issues: [] })
  let issue = openIssue(created)
  for (let night = 2; night <= greenRunsToClose; night++) {
    const [action] = planIssueActions({
      report: reportOf(),
      issues: [issue],
      run: nightly(night),
    })
    assert.equal(action.action, 'green', `night ${night}`)
    assert.equal(parseIssueState(action.body).greenRuns, night - 1)
    issue = { ...issue, body: action.body }
  }
  const [closing] = planIssueActions({
    report: reportOf(),
    issues: [issue],
    run: nightly(greenRunsToClose + 1),
  })
  assert.equal(closing.action, 'close')
  assert.equal(closing.issue, 41)
  assert.equal(parseIssueState(closing.body).greenRuns, greenRunsToClose)
})

test('a sighting restarts the green run count', () => {
  const [created] = plan({ report: reportOf({ flaky: [row()] }), issues: [] })
  let issue = openIssue(created)
  for (const night of [2, 3, 4]) {
    const [action] = planIssueActions({
      report: reportOf(),
      issues: [issue],
      run: nightly(night),
    })
    issue = { ...issue, body: action.body }
  }
  const [seenAgain] = planIssueActions({
    report: reportOf({ flaky: [row()] }),
    issues: [issue],
    run: nightly(5),
  })
  assert.equal(seenAgain.action, 'append')
  assert.equal(parseIssueState(seenAgain.body).greenRuns, 0)

  issue = { ...issue, body: seenAgain.body }
  for (let night = 6; night < 6 + greenRunsToClose - 1; night++) {
    const [action] = planIssueActions({
      report: reportOf(),
      issues: [issue],
      run: nightly(night),
    })
    assert.equal(action.action, 'green', `night ${night}`)
    issue = { ...issue, body: action.body }
  }
  const [closing] = planIssueActions({
    report: reportOf(),
    issues: [issue],
    run: nightly(6 + greenRunsToClose),
  })
  assert.equal(closing.action, 'close')
})

test('the same nightly run changes an issue once', () => {
  const [created] = plan({ report: reportOf({ flaky: [row()] }), issues: [] })
  const issue = openIssue(created)
  for (const report of [reportOf({ flaky: [row()] }), reportOf()]) {
    const [action] = planIssueActions({
      report,
      issues: [issue],
      run: nightly(1),
    })
    assert.deepEqual(action, {
      action: 'skip',
      reason: 'already-recorded',
      issue: 41,
    })
  }
})

test('an issue the detector did not write is left alone', () => {
  const actions = plan({
    report: reportOf(),
    issues: [
      { number: 7, title: 'flaky-ish, filed by hand', body: 'no marker here' },
      { number: 8, title: 'empty', body: null },
    ],
  })
  assert.deepEqual(actions, [
    { action: 'skip', reason: 'unmanaged', issue: 7 },
    { action: 'skip', reason: 'unmanaged', issue: 8 },
  ])
})

test('a duplicated issue is reported, not updated twice', () => {
  const [created] = plan({ report: reportOf({ flaky: [row()] }), issues: [] })
  const actions = planIssueActions({
    report: reportOf({ flaky: [row()] }),
    issues: [openIssue(created, 41), openIssue(created, 42)],
    run: nightly(2),
  })
  assert.deepEqual(
    actions.map((action) => [action.action, action.reason ?? action.issue]),
    [
      ['skip', 'duplicate'],
      ['append', 41],
    ],
  )
})

test('a test name that would break the table stays intact in the state', () => {
  const awkward = row({
    testName: 'renders <Toolbar /> | and `code`',
    firstError: 'Expected a --> b, got c | d',
  })
  const [created] = plan({ report: reportOf({ flaky: [awkward] }), issues: [] })
  assert.ok(created.body.includes("- Test: `renders <Toolbar /> | and 'code'`"))
  assert.match(created.body, /&#124; d/u)
  // Nothing may end the state comment early, or the rest of it renders as text.
  assert.equal(created.body.split('-->').length, 2)
  const state = parseIssueState(created.body)
  assert.equal(state.row.testName, 'renders <Toolbar /> | and `code`')
  assert.equal(state.sightings[0].firstError, 'Expected a --> b, got c | d')
  const [action] = planIssueActions({
    report: reportOf({ flaky: [awkward] }),
    issues: [openIssue(created)],
    run: nightly(2),
  })
  assert.equal(action.action, 'append')
})

test('the sightings table keeps the most recent rows and the total', () => {
  let issue
  let action = plan({ report: reportOf({ flaky: [row()] }), issues: [] })[0]
  for (let night = 2; night <= 25; night++) {
    issue = openIssue({ ...action, title: 'kept' })
    action = planIssueActions({
      report: reportOf({ flaky: [row({ failureCount: night })] }),
      issues: [issue],
      run: nightly(night),
    })[0]
  }
  const state = parseIssueState(action.body)
  assert.equal(state.sightingCount, 25)
  assert.equal(state.sightings.length, 20)
  assert.equal(state.sightings.at(-1).failureCount, 25)
  assert.equal(state.sightings[0].failureCount, 6)
})

test('a report with nothing to track changes nothing', () => {
  assert.deepEqual(plan({ report: reportOf(), issues: [] }), [])
})

for (const [name, context, expected] of [
  [
    'a scheduled run on the default branch',
    { eventName: 'schedule', ref: 'refs/heads/main', defaultBranch: 'main' },
    'write',
  ],
  [
    'a manual run',
    {
      eventName: 'workflow_dispatch',
      ref: 'refs/heads/main',
      defaultBranch: 'main',
    },
    'dry-run',
  ],
  [
    'a scheduled run on another ref',
    {
      eventName: 'schedule',
      ref: 'refs/heads/claude/experiment',
      defaultBranch: 'main',
    },
    'dry-run',
  ],
  [
    'a run with no default branch to compare',
    { eventName: 'schedule', ref: 'refs/heads/main', defaultBranch: '' },
    'dry-run',
  ],
])
  test(`${name} syncs in ${expected} mode`, () => {
    assert.equal(syncMode(context), expected)
  })

function githubStub({ issues = [], label = true, pages } = {}) {
  const calls = []
  let number = 100
  const ok = (payload, status = 200) => ({
    ok: true,
    status,
    json: () => payload,
  })
  const fetchImpl = (url, init = {}) => {
    const method = init.method ?? 'GET'
    calls.push({
      method,
      path: url.pathname,
      search: url.search,
      body: init.body === undefined ? undefined : JSON.parse(init.body),
      headers: init.headers,
    })
    if (url.pathname.endsWith(`/labels/${flakyLabel}`))
      return label ? ok({ name: flakyLabel }) : { ok: false, status: 404 }
    if (url.pathname.endsWith('/labels')) return ok({ name: flakyLabel }, 201)
    if (url.pathname.endsWith('/issues') && method === 'GET')
      return ok(pages ? (pages.shift() ?? []) : issues)
    if (url.pathname.endsWith('/issues')) return ok({ number: ++number }, 201)
    if (method === 'PATCH') return ok({ number: 1 })
    throw new Error(`unexpected ${method} ${url.pathname}`)
  }
  return { calls, fetchImpl }
}

const sync = ({ report, mode = 'write', run = nightly(1), ...stub }) => {
  const github = githubStub(stub)
  return {
    github,
    result: syncFlakyIssues({
      repository: 'artifactshare/artifactshare',
      token: 'test-token',
      fetchImpl: github.fetchImpl,
      report,
      run,
      mode,
    }),
  }
}

test('filing an issue creates the label only when it is missing', async () => {
  for (const label of [true, false]) {
    const { github, result } = sync({
      report: reportOf({ flaky: [row()] }),
      label,
    })
    const { applied } = await result
    assert.equal(applied[0].issue, 101)
    const created = github.calls.filter(
      (call) => call.method === 'POST' && call.path.endsWith('/labels'),
    )
    assert.equal(created.length, label ? 0 : 1)
    if (!label) assert.equal(created[0].body.name, flakyLabel)
    const filed = github.calls.find(
      (call) => call.method === 'POST' && call.path.endsWith('/issues'),
    )
    assert.deepEqual(filed.body.labels, [flakyLabel])
    assert.match(filed.body.title, /^Flaky: /u)
    assert.equal(filed.headers.authorization, 'Bearer test-token')
  }
})

test('closing an issue states the reason and keeps the record', async () => {
  const [created] = plan({ report: reportOf({ flaky: [row()] }), issues: [] })
  let issue = openIssue(created)
  for (let night = 2; night <= greenRunsToClose; night++) {
    const [action] = planIssueActions({
      report: reportOf(),
      issues: [issue],
      run: nightly(night),
    })
    issue = { ...issue, body: action.body }
  }
  const { github, result } = sync({
    report: reportOf(),
    issues: [issue],
    run: nightly(greenRunsToClose + 1),
  })
  await result
  const patch = github.calls.find((call) => call.method === 'PATCH')
  assert.equal(patch.path, '/repos/artifactshare/artifactshare/issues/41')
  assert.equal(patch.body.state, 'closed')
  assert.equal(patch.body.state_reason, 'completed')
  assert.match(patch.body.body, /## Sightings \(1\)/u)
  assert.match(
    patch.body.body,
    new RegExp(`${greenRunsToClose} of ${greenRunsToClose}`, 'u'),
  )
})

test('a dry run reads the issues and writes nothing', async () => {
  const { github, result } = sync({
    report: reportOf({ flaky: [row()] }),
    mode: 'dry-run',
  })
  const { actions, applied } = await result
  assert.deepEqual(applied, [])
  assert.deepEqual(
    actions.map((action) => action.action),
    ['create'],
  )
  assert.deepEqual(
    github.calls.map((call) => call.method),
    ['GET'],
  )
  const summary = summarizeActions({ mode: 'dry-run', actions })
  assert.match(summary, /Mode: dry-run\. create 1, append 0/u)
})

test('the issue list skips pull requests and follows every page', async () => {
  const page = (length, from) =>
    Array.from({ length }, (unused, index) => ({
      number: from + index,
      title: 'row',
      body: 'body',
    }))
  const github = githubStub({
    pages: [
      [
        ...page(99, 1),
        { number: 500, title: 'a pull request', pull_request: {} },
      ],
      page(2, 200),
    ],
  })
  const issues = await listFlakyIssues({
    repository: 'artifactshare/artifactshare',
    token: 'test-token',
    fetchImpl: github.fetchImpl,
  })
  assert.equal(issues.length, 101)
  assert.ok(!issues.some((issue) => issue.number === 500))
  assert.equal(github.calls.length, 2)
  assert.match(github.calls[0].search, /labels=flaky&state=open/u)
  assert.match(github.calls[1].search, /page=2/u)
})

test('a refused GitHub request fails loudly', async () => {
  await assert.rejects(
    syncFlakyIssues({
      repository: 'artifactshare/artifactshare',
      token: 'test-token',
      fetchImpl: () => ({ ok: false, status: 403 }),
      report: reportOf({ flaky: [row()] }),
      run: nightly(1),
      mode: 'write',
    }),
    /403/u,
  )
})

test('a run without a report leaves every issue untouched', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'flaky-issues-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const summary = path.join(directory, 'summary.md')
  const result = spawnSync(
    process.execPath,
    [
      'scripts/ci/flaky-issues.mjs',
      path.join(directory, 'missing-report.json'),
      summary,
    ],
    { encoding: 'utf8', env: { ...process.env, GITHUB_TOKEN: '' } },
  )
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /No report to read\. No issue changed\./u)
  assert.match(fs.readFileSync(summary, 'utf8'), /No issue changed/u)
})

test('a long test name is cut to fit a title', () => {
  const title = issueTitle('flaky', row({ testName: 'x'.repeat(300) }))
  assert.equal(title.length, 200)
  assert.ok(title.startsWith('Flaky: xxx'))
  assert.ok(title.endsWith('…'))
})
