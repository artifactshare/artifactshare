import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isUiFile, parseArgs, ready } from './pr-ready.mjs'

const head = 'a'.repeat(40)

/** Never the checkout's own ledger: a test that wrote there would discharge a
 * real deferral, which is the loss this record exists to prevent. */
const tempLedger = () => join(tmpdir(), `pr-ready-ledger-${randomUUID()}.json`)

function tempUsageReport() {
  const markdown =
    '<!-- artifactshare:workflow-usage:start -->\nfixture\n<!-- artifactshare:workflow-usage:end -->\n'
  const usage = {
    rawInputTokens: 1,
    cacheReadInputTokens: 0,
    cacheWriteInputTokens: 0,
    inputTokens: 1,
    outputTokens: 1,
    totalTokens: 2,
  }
  const report = {
    schemaVersion: 2,
    kind: 'artifactshare.workflow_usage',
    target: { headSha: head },
    coverage: { status: 'complete', reasons: [] },
    totals: { measured: usage, complete: usage },
    wallElapsedMs: 10,
    invocationDurationMs: 10,
    rows: [
      {
        stage: 'implementation',
        attempt: 1,
        provider: 'codex',
        outcome: 'succeeded',
        durationMs: 10,
        usageSource: 'ccusage_interval',
        requestedModel: 'gpt-5.6-sol',
        requestedEffort: 'medium',
        reportedModels: ['gpt-5.6-sol'],
        usage,
        coverageReasons: [],
      },
    ],
    markdown,
  }
  const path = join(tmpdir(), `pr-ready-usage-${randomUUID()}.json`)
  writeFileSync(path, JSON.stringify(report))
  return path
}

function harness({
  remoteHead = head,
  draft = true,
  base = 'main',
  dirty = false,
  changedFiles = [],
  body = undefined,
} = {}) {
  const calls = []
  const usageReport = tempUsageReport()
  const exec = (file, args) => {
    calls.push([file, args])
    if (file === 'git' && args[0] === 'branch') return 'topic\n'
    if (file === 'git' && args[0] === 'rev-parse') return `${head}\n`
    if (file === 'git' && args[0] === 'status') return dirty ? ' M file' : ''
    if (file === 'git' && args[0] === 'diff') return changedFiles.join('\n')
    if (file === 'gh' && args[1] === 'list')
      return JSON.stringify([
        {
          number: 56,
          isDraft: draft,
          baseRefName: base,
          headRefName: 'topic',
          headRefOid: remoteHead,
          body: body ?? JSON.parse(readFileSync(usageReport, 'utf8')).markdown,
        },
      ])
    return ''
  }
  return { calls, exec, usageReport }
}

test('needs no reviewer SHA arguments', () => {
  assert.deepEqual(parseArgs([]), {
    deferred: [],
    deferredFile: undefined,
    taskUsageReport: undefined,
    dryRun: false,
    uiGateComplete: false,
    noDeferred: false,
  })
  assert.deepEqual(
    parseArgs(['--', '--dry-run', '--ui-gate-complete', '--no-deferred']),
    {
      deferred: [],
      deferredFile: undefined,
      taskUsageReport: undefined,
      dryRun: true,
      uiGateComplete: true,
      noDeferred: true,
    },
  )
  assert.deepEqual(parseArgs(['--deferred', 'aria label on the select']), {
    deferred: ['aria label on the select'],
    deferredFile: undefined,
    taskUsageReport: undefined,
    dryRun: false,
    uiGateComplete: false,
    noDeferred: false,
  })
  assert.equal(
    parseArgs(['--task-usage-report', '/tmp/report.json']).taskUsageReport,
    '/tmp/report.json',
  )
  assert.throws(() => parseArgs(['--codex-go', head]), /Usage/u)
})

test('requires a sanitized task usage report before Ready', () => {
  const h = harness()
  assert.throws(
    () =>
      ready({
        exec: h.exec,
        parsed: { dryRun: false, deferred: [], noDeferred: true },
        ledger: tempLedger(),
      }),
    /sanitized task usage report is required/u,
  )
  assert.equal(
    h.calls.some(([file, args]) => file === 'gh' && args[1] === 'ready'),
    false,
  )
})

test('allows a reasoned partial report and rejects an unreasoned unknown', () => {
  const partialPath = tempUsageReport()
  const partial = JSON.parse(readFileSync(partialPath, 'utf8'))
  partial.coverage = {
    status: 'partial',
    reasons: ['measurement_unresolved'],
  }
  partial.totals = { measured: null, complete: null }
  partial.rows[0].durationMs = null
  partial.rows[0].usageSource = null
  partial.rows[0].usage = null
  partial.rows[0].coverageReasons = ['measurement_unresolved']
  partial.markdown =
    '<!-- artifactshare:workflow-usage:start -->\npartial\n<!-- artifactshare:workflow-usage:end -->\n'
  writeFileSync(partialPath, JSON.stringify(partial))
  const h = harness({ body: partial.markdown })
  ready({
    exec: h.exec,
    parsed: {
      dryRun: false,
      deferred: [],
      noDeferred: true,
      taskUsageReport: partialPath,
    },
    ledger: tempLedger(),
  })
  assert.equal(
    h.calls.some(([file, args]) => file === 'gh' && args[1] === 'ready'),
    true,
  )

  partial.rows[0].coverageReasons = []
  writeFileSync(partialPath, JSON.stringify(partial))
  const invalid = harness({ body: partial.markdown })
  assert.throws(
    () =>
      ready({
        exec: invalid.exec,
        parsed: {
          dryRun: false,
          deferred: [],
          noDeferred: true,
          taskUsageReport: partialPath,
        },
        ledger: tempLedger(),
      }),
    /unreasoned unknown usage/u,
  )
})

test('requires the PR body to contain the exact generated usage block', () => {
  const h = harness({ body: 'workflow usage was recorded elsewhere' })
  assert.throws(
    () =>
      ready({
        exec: h.exec,
        parsed: {
          dryRun: false,
          deferred: [],
          noDeferred: true,
          taskUsageReport: h.usageReport,
        },
        ledger: tempLedger(),
      }),
    /exactly one workflow usage marker block/u,
  )
  assert.equal(
    h.calls.some(([file, args]) => file === 'gh' && args[1] === 'ready'),
    false,
  )
})

test('binds the task usage report to the local and PR heads', () => {
  const path = tempUsageReport()
  const value = JSON.parse(readFileSync(path, 'utf8'))
  value.target.headSha = 'b'.repeat(40)
  writeFileSync(path, JSON.stringify(value))
  const h = harness()
  assert.throws(
    () =>
      ready({
        exec: h.exec,
        parsed: {
          dryRun: false,
          deferred: [],
          noDeferred: true,
          taskUsageReport: path,
        },
        ledger: tempLedger(),
      }),
    /does not target the current local HEAD/u,
  )
  assert.equal(
    h.calls.some(([file, args]) => file === 'gh' && args[1] === 'ready'),
    false,
  )
})

test('rejects row and total arithmetic that is internally valid but inconsistent', () => {
  const path = tempUsageReport()
  const value = JSON.parse(readFileSync(path, 'utf8'))
  value.totals.measured = {
    rawInputTokens: 0,
    cacheReadInputTokens: 0,
    cacheWriteInputTokens: 0,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
  }
  value.totals.complete = value.totals.measured
  writeFileSync(path, JSON.stringify(value))
  const h = harness()
  assert.throws(
    () =>
      ready({
        exec: h.exec,
        parsed: {
          dryRun: false,
          deferred: [],
          noDeferred: true,
          taskUsageReport: path,
        },
        ledger: tempLedger(),
      }),
    /totals do not match rows/u,
  )
  assert.equal(
    h.calls.some(([file, args]) => file === 'gh' && args[1] === 'ready'),
    false,
  )
})

test('requires one exact workflow usage block and tolerates editor line endings', () => {
  const reportPath = tempUsageReport()
  const reportMarkdown = JSON.parse(readFileSync(reportPath, 'utf8')).markdown
  const crlfBody = reportMarkdown.replaceAll('\n', '\r\n').replace(/\r\n$/u, '')
  const crlfHarness = harness({ body: crlfBody })
  ready({
    exec: crlfHarness.exec,
    parsed: {
      dryRun: false,
      deferred: [],
      noDeferred: true,
      taskUsageReport: crlfHarness.usageReport,
    },
    ledger: tempLedger(),
  })

  const duplicate = harness({ body: `${reportMarkdown}\n${reportMarkdown}` })
  assert.throws(
    () =>
      ready({
        exec: duplicate.exec,
        parsed: {
          dryRun: false,
          deferred: [],
          noDeferred: true,
          taskUsageReport: duplicate.usageReport,
        },
        ledger: tempLedger(),
      }),
    /exactly one workflow usage marker block/u,
  )
  assert.equal(
    duplicate.calls.some(
      ([file, args]) => file === 'gh' && args[1] === 'ready',
    ),
    false,
  )

  const malformed = JSON.parse(readFileSync(reportPath, 'utf8'))
  malformed.markdown = `${reportMarkdown}\n${reportMarkdown}`
  writeFileSync(reportPath, JSON.stringify(malformed))
  const malformedHarness = harness()
  assert.throws(
    () =>
      ready({
        exec: malformedHarness.exec,
        parsed: {
          dryRun: false,
          deferred: [],
          noDeferred: true,
          taskUsageReport: reportPath,
        },
        ledger: tempLedger(),
      }),
    /one marker pair/u,
  )
})

test('classifies user-visible web files without treating tests or API routes as UI', () => {
  for (const file of [
    'apps/web/app/components/button.tsx',
    'apps/web/app/components/app/landing-styles.ts',
    'apps/web/app/hooks/use-hydrated.ts',
    'apps/web/app/routes/pricing.tsx',
    'apps/web/app/routes/_home/+components/home-view.ts',
    'apps/web/app/app.css',
    'apps/web/app/lib/app-theme.ts',
    'apps/web/app/lib/markdown-render.ts',
    'apps/web/app/lib/mermaid-render.client.ts',
    'apps/web/app/i18n/ja.json',
    'apps/web/app/guides/workspace-owner.en.md',
    'apps/web/app/legal/privacy.ja.md',
    'apps/web/app/updates/entries/example.en.md',
    'apps/web/public/landing/hero.svg',
  ])
    assert.equal(isUiFile(file), true, file)

  for (const file of [
    'apps/web/app/components/button.test.tsx',
    'apps/web/app/components/catalog.test.ts',
    'apps/web/app/routes/api.artifacts.tsx',
    'apps/web/app/services/project.server.ts',
    'apps/web/app/lib/app-theme.server.ts',
    'packages/cli/src/index.ts',
  ])
    assert.equal(isUiFile(file), false, file)
})

test('blocks UI changes until capture and source-based critique are confirmed', () => {
  const h = harness({ changedFiles: ['apps/web/app/routes/pricing.tsx'] })
  assert.throws(
    () =>
      ready({
        exec: h.exec,
        parsed: {
          dryRun: false,
          uiGateComplete: false,
          taskUsageReport: h.usageReport,
        },
        ledger: tempLedger(),
      }),
    (error) => {
      assert.match(
        error.message,
        /Every affected screen state and registered task has been captured at desktop and mobile/u,
      )
      assert.match(error.message, /relevant source/u)
      assert.match(error.message, /walkthrough evidence/u)
      assert.match(error.message, /task\/persona context/u)
      assert.match(error.message, /captures alone are not sufficient/u)
      assert.match(error.message, /recapture and repeat the critique/u)
      assert.match(
        error.message,
        /--task-usage-report <path> --ui-gate-complete/u,
      )
      return true
    },
  )
  assert.equal(
    h.calls.some(([file, args]) => file === 'gh' && args[1] === 'ready'),
    false,
  )
})

test('allows confirmed UI changes and does not gate non-UI changes', () => {
  for (const [changedFiles, uiGateComplete] of [
    [['apps/web/app/components/button.tsx'], true],
    [['packages/cli/src/index.ts'], false],
  ]) {
    const h = harness({ changedFiles })
    ready({
      exec: h.exec,
      parsed: {
        dryRun: false,
        uiGateComplete,
        deferred: [],
        noDeferred: true,
        taskUsageReport: h.usageReport,
      },
      ledger: tempLedger(),
    })
    assert.equal(
      h.calls.some(([file, args]) => file === 'gh' && args[1] === 'ready'),
      true,
    )
  }
})

test('checks required status then makes the pushed Draft ready', () => {
  const h = harness()
  assert.deepEqual(
    ready({
      exec: h.exec,
      parsed: {
        dryRun: false,
        deferred: [],
        noDeferred: true,
        taskUsageReport: h.usageReport,
      },
      ledger: tempLedger(),
    }),
    { number: 56, head, dryRun: false, deferred: 0 },
  )
  const commands = h.calls.map(([file, args]) => `${file} ${args.join(' ')}`)
  assert.ok(
    commands.indexOf('gh pr checks 56 --required') <
      commands.indexOf('gh pr ready 56'),
  )
})

test('rejects dirty, stale, non-Draft, and wrong-base state before Ready', () => {
  for (const options of [
    { dirty: true },
    { remoteHead: 'b'.repeat(40) },
    { draft: false },
    { base: 'release' },
  ]) {
    const h = harness(options)
    assert.throws(() =>
      ready({
        exec: h.exec,
        parsed: {
          dryRun: false,
          deferred: [],
          noDeferred: true,
          taskUsageReport: h.usageReport,
        },
        ledger: tempLedger(),
      }),
    )
    assert.equal(
      h.calls.some(([file, args]) => file === 'gh' && args[1] === 'ready'),
      false,
    )
  }
})

test('does not attempt repository-specific rollback after Ready', () => {
  const h = harness()
  h.exec = (file, args) => {
    if (file === 'gh' && args[1] === 'ready') throw new Error('GitHub failed')
    return harness().exec(file, args)
  }
  assert.throws(
    () =>
      ready({
        exec: h.exec,
        parsed: {
          dryRun: false,
          deferred: [],
          noDeferred: true,
          taskUsageReport: h.usageReport,
        },
        ledger: tempLedger(),
      }),
    /GitHub failed/u,
  )
})

test('a corrupt ledger leaves Ready unchanged rather than overwriting it', () => {
  const path = join(tmpdir(), `pr-ready-corrupt-${randomUUID()}.json`)
  writeFileSync(path, '{ truncated')
  const h = harness()
  assert.throws(
    () =>
      ready({
        exec: h.exec,
        parsed: {
          dryRun: false,
          deferred: ['something'],
          noDeferred: false,
          taskUsageReport: h.usageReport,
        },
        ledger: path,
      }),
    /could not be read/u,
  )
  assert.equal(
    h.calls.some(([file, args]) => file === 'gh' && args[1] === 'ready'),
    false,
  )
})
