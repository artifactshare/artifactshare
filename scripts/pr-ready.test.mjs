import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  isUiFile,
  parseArgs,
  ready,
  renderCanonicalWorkflowUsageMarkdown,
} from './pr-ready.mjs'

const head = 'a'.repeat(40)

/** Never the checkout's own ledger: a test that wrote there would discharge a
 * real deferral, which is the loss this record exists to prevent. */
const tempLedger = () => join(tmpdir(), `pr-ready-ledger-${randomUUID()}.json`)

function tempUsageReport() {
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
        reportedEffort: 'medium',
        reportedModels: ['gpt-5.6-sol'],
        usage,
        coverageReasons: [],
      },
    ],
    markdown: '',
  }
  report.markdown = renderCanonicalWorkflowUsageMarkdown(report)
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
          body:
            body ??
            `## Workflow usage\n\n${JSON.parse(readFileSync(usageReport, 'utf8')).markdown}`,
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
  partial.rows[0].coverageReasons = [
    'measurement_unresolved',
    'duration_unavailable',
    'usage_unavailable',
    'requested_model_unrecorded',
    'requested_effort_unrecorded',
    'reported_effort_unavailable',
    'reported_models_unavailable',
  ]
  partial.markdown = renderCanonicalWorkflowUsageMarkdown(partial)
  writeFileSync(partialPath, JSON.stringify(partial))
  const h = harness({ body: `## Workflow usage\n\n${partial.markdown}` })
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
  partial.markdown = renderCanonicalWorkflowUsageMarkdown(partial)
  writeFileSync(partialPath, JSON.stringify(partial))
  const invalid = harness({
    body: `## Workflow usage\n\n${partial.markdown}`,
  })
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
    /unreasoned unknown value/u,
  )
})

test('rejects active executions and unsealed inventories before Ready', () => {
  for (const mutate of [
    (value) => {
      value.coverage = {
        status: 'partial',
        reasons: ['task_inventory_not_sealed'],
      }
    },
    (value) => {
      value.coverage = {
        status: 'partial',
        reasons: ['execution_active'],
      }
      value.rows[0].outcome = 'active'
      value.rows[0].durationMs = null
      value.rows[0].usage = null
      value.rows[0].usageSource = null
      value.rows[0].coverageReasons = [
        'execution_active',
        'duration_unavailable',
        'usage_unavailable',
      ]
      value.totals = { measured: null, complete: null }
    },
  ]) {
    const path = tempUsageReport()
    const value = JSON.parse(readFileSync(path, 'utf8'))
    mutate(value)
    value.markdown = renderCanonicalWorkflowUsageMarkdown(value)
    writeFileSync(path, JSON.stringify(value))
    const h = harness({ body: `## Workflow usage\n\n${value.markdown}` })
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
      /sealed inventory and no active executions|still active/u,
    )
    assert.equal(
      h.calls.some(([file, args]) => file === 'gh' && args[1] === 'ready'),
      false,
    )
  }
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

test('rejects a stale workflow table left beside the generated block', () => {
  const reportPath = tempUsageReport()
  const reportMarkdown = JSON.parse(readFileSync(reportPath, 'utf8')).markdown
  const h = harness({
    body: `## Workflow usage\n\n${reportMarkdown}\n\n| Execution | Model (requested → reported) | Effort (requested → reported) |\n| --- | --- | --- |`,
  })
  assert.throws(
    () =>
      ready({
        exec: h.exec,
        parsed: {
          dryRun: false,
          deferred: [],
          noDeferred: true,
          taskUsageReport: reportPath,
        },
        ledger: tempLedger(),
      }),
    /Workflow usage section must contain only/u,
  )
})

test('binds the task usage report to the local and PR heads', () => {
  const path = tempUsageReport()
  const value = JSON.parse(readFileSync(path, 'utf8'))
  value.target.headSha = 'b'.repeat(40)
  value.markdown = renderCanonicalWorkflowUsageMarkdown(value)
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
  value.markdown = renderCanonicalWorkflowUsageMarkdown(value)
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

test('rejects unsupported public metadata values', () => {
  for (const mutate of [
    (value) => {
      value.rows[0].requestedModel = 'customer-acme-prod'
    },
    (value) => {
      value.rows[0].requestedModel = 'gpt-5.6-sol:customer-acme'
    },
    (value) => {
      value.rows[0].requestedEffort = 'tenant-high'
    },
    (value) => {
      value.rows[0].reportedEffort = 'tenant-high'
    },
    (value) => {
      value.rows[0].reportedModels = ['model@private-routing']
    },
    (value) => {
      value.rows[0].usageSource = 'customer-usage-path'
    },
  ]) {
    const path = tempUsageReport()
    const value = JSON.parse(readFileSync(path, 'utf8'))
    mutate(value)
    value.markdown = renderCanonicalWorkflowUsageMarkdown(value)
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
      /unsupported/u,
    )
    assert.equal(
      h.calls.some(([file, args]) => file === 'gh' && args[1] === 'ready'),
      false,
    )
  }
})

test('accepts the full supported Codex effort vocabulary', () => {
  const path = tempUsageReport()
  const value = JSON.parse(readFileSync(path, 'utf8'))
  value.rows[0].requestedEffort = 'ultra'
  value.rows[0].reportedEffort = 'ultra'
  value.markdown = renderCanonicalWorkflowUsageMarkdown(value)
  writeFileSync(path, JSON.stringify(value))
  const h = harness({ body: `## Workflow usage\n\n${value.markdown}` })
  ready({
    exec: h.exec,
    parsed: {
      dryRun: false,
      deferred: [],
      noDeferred: true,
      taskUsageReport: path,
    },
    ledger: tempLedger(),
  })
})

test('allows measured usage when an unsafe source is reasoned as unavailable', () => {
  const path = tempUsageReport()
  const value = JSON.parse(readFileSync(path, 'utf8'))
  value.coverage = {
    status: 'partial',
    reasons: ['usage_source_unavailable'],
  }
  value.totals.complete = null
  value.rows[0].usageSource = null
  value.rows[0].coverageReasons = ['usage_source_unavailable']
  value.markdown = renderCanonicalWorkflowUsageMarkdown(value)
  writeFileSync(path, JSON.stringify(value))
  const h = harness({ body: `## Workflow usage\n\n${value.markdown}` })
  ready({
    exec: h.exec,
    parsed: {
      dryRun: false,
      deferred: [],
      noDeferred: true,
      taskUsageReport: path,
    },
    ledger: tempLedger(),
  })
})

test('requires the matching reason for every unknown row field', () => {
  const path = tempUsageReport()
  const value = JSON.parse(readFileSync(path, 'utf8'))
  value.coverage = { status: 'partial', reasons: ['measurement_unresolved'] }
  value.totals.complete = null
  value.rows[0].reportedEffort = null
  value.rows[0].coverageReasons = ['duration_unavailable']
  value.markdown = renderCanonicalWorkflowUsageMarkdown(value)
  writeFileSync(path, JSON.stringify(value))
  const h = harness({ body: `## Workflow usage\n\n${value.markdown}` })
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
    /reportedEffort.*reported_effort_unavailable/u,
  )
})

test('rejects a marker block that does not project the report fields', () => {
  const path = tempUsageReport()
  const value = JSON.parse(readFileSync(path, 'utf8'))
  value.markdown = value.markdown.replace(
    '1 in / 1 out / 2 total',
    '9 in / 1 out / 10 total',
  )
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
    /markdown does not match report data/u,
  )
})

test('requires complete timing and model metadata', () => {
  for (const mutate of [
    (value) => {
      value.wallElapsedMs = null
    },
    (value) => {
      value.invocationDurationMs = 0
    },
    (value) => {
      value.wallElapsedMs = 0
    },
    (value) => {
      value.rows[0].requestedModel = null
    },
    (value) => {
      value.rows[0].requestedEffort = null
    },
    (value) => {
      value.rows[0].reportedEffort = null
    },
    (value) => {
      value.rows[0].reportedModels = []
    },
  ]) {
    const path = tempUsageReport()
    const value = JSON.parse(readFileSync(path, 'utf8'))
    mutate(value)
    value.markdown = renderCanonicalWorkflowUsageMarkdown(value)
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
      (error) => {
        assert.match(
          error.message,
          /timing totals|invocation duration does not match rows|does not cover known rows|wall elapsed|model metadata|unreasoned unknown value/u,
        )
        return true
      },
    )
  }
})

test('requires reasons for partial row unknowns and checks known duration sums', () => {
  const path = tempUsageReport()
  const value = JSON.parse(readFileSync(path, 'utf8'))
  value.coverage = {
    status: 'partial',
    reasons: ['another_execution_unresolved'],
  }
  value.totals.complete = null
  value.rows[0].durationMs = null
  value.rows[0].requestedModel = null
  value.rows[0].requestedEffort = null
  value.rows[0].reportedModels = []
  value.rows[0].coverageReasons = []
  value.markdown = renderCanonicalWorkflowUsageMarkdown(value)
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
    /unreasoned unknown value/u,
  )

  value.rows[0].durationMs = 10
  value.rows[0].requestedModel = 'gpt-5.6-sol'
  value.rows[0].requestedEffort = 'medium'
  value.rows[0].reportedModels = ['gpt-5.6-sol']
  value.rows.push({
    ...value.rows[0],
    attempt: 2,
    durationMs: null,
    usageSource: null,
    requestedModel: null,
    requestedEffort: null,
    reportedEffort: null,
    reportedModels: [],
    usage: null,
    coverageReasons: [
      'duration_unavailable',
      'usage_unavailable',
      'requested_model_unrecorded',
      'requested_effort_unrecorded',
      'reported_effort_unavailable',
      'reported_models_unavailable',
    ],
  })
  value.invocationDurationMs = 0
  value.markdown = renderCanonicalWorkflowUsageMarkdown(value)
  writeFileSync(path, JSON.stringify(value))
  const inconsistent = harness()
  assert.throws(
    () =>
      ready({
        exec: inconsistent.exec,
        parsed: {
          dryRun: false,
          deferred: [],
          noDeferred: true,
          taskUsageReport: path,
        },
        ledger: tempLedger(),
      }),
    /invocation duration does not cover known rows/u,
  )
})

test('requires one exact workflow usage block and tolerates editor line endings', () => {
  const reportPath = tempUsageReport()
  const reportMarkdown = JSON.parse(readFileSync(reportPath, 'utf8')).markdown
  const crlfBody = `## Workflow usage\r\n\r\n${reportMarkdown
    .replaceAll('\n', '\r\n')
    .replace(/\r\n$/u, '')}`
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

  const duplicate = harness({
    body: `## Workflow usage\n\n${reportMarkdown}\n${reportMarkdown}`,
  })
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
