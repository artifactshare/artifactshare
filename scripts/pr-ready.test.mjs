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
  runReady,
  renderCanonicalWorkflowUsageMarkdown,
} from './pr-ready.mjs'

import { landed, renderLandedResult } from './pr-landed.mjs'

import { readLedger as readLandingLedger } from './landing-ledger.mjs'

const head = 'a'.repeat(40)

function otherPr(number, branch, overrides = {}) {
  return {
    number,
    isDraft: true,
    baseRefName: 'main',
    headRefName: branch,
    headRefOid: String(number).padStart(40, '0'),
    body: 'Other public PR',
    isCrossRepository: false,
    ...overrides,
  }
}

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
    schemaVersion: 3,
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
  otherPrs = [],
} = {}) {
  const calls = []
  const usageReport = tempUsageReport()
  let currentDraft = draft
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
          isDraft: currentDraft,
          baseRefName: base,
          headRefName: 'topic',
          headRefOid: remoteHead,
          isCrossRepository: false,
          body:
            body ??
            `## Workflow usage\n\n${JSON.parse(readFileSync(usageReport, 'utf8')).markdown}`,
        },
        ...otherPrs,
      ])
    if (file === 'gh' && args[1] === 'ready') {
      currentDraft = args.includes('--undo')
      return ''
    }
    return ''
  }
  return { calls, exec, usageReport }
}

test('needs no reviewer SHA arguments', () => {
  assert.deepEqual(parseArgs([]), {
    deferred: [],
    deferredFile: undefined,
    taskUsageReport: undefined,
    queue: false,
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
      queue: false,
      dryRun: true,
      uiGateComplete: true,
      noDeferred: true,
    },
  )
  assert.deepEqual(parseArgs(['--deferred', 'aria label on the select']), {
    deferred: ['aria label on the select'],
    deferredFile: undefined,
    taskUsageReport: undefined,
    queue: false,
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

test('allows Ready with no workflow usage block and no report', () => {
  const h = harness({
    body: '## Workflow usage\n\nOptional. No workflow usage was included.',
  })
  ready({
    exec: h.exec,
    parsed: { dryRun: false, deferred: [], noDeferred: true },
    ledger: tempLedger(),
  })
  assert.equal(
    h.calls.some(([file, args]) => file === 'gh' && args[1] === 'ready'),
    true,
  )
})

test('selects the current branch with two or three open PRs', () => {
  for (const otherPrs of [
    [otherPr(57, 'other/one')],
    [otherPr(57, 'other/one'), otherPr(58, 'other/two')],
  ]) {
    const h = harness({
      body: '## Workflow usage\n\nOptional. No workflow usage was included.',
      otherPrs,
    })
    assert.deepEqual(
      ready({
        exec: h.exec,
        parsed: { dryRun: false, deferred: [], noDeferred: true },
        ledger: tempLedger(),
      }),
      { number: 56, head, dryRun: false, deferred: 0 },
    )
  }
})

test('does not select a cross-repository branch-name collision', () => {
  const h = harness({
    body: '## Workflow usage\n\nOptional. No workflow usage was included.',
    otherPrs: [
      otherPr(57, 'topic', { isCrossRepository: true }),
      otherPr(58, 'other/two'),
    ],
  })
  assert.deepEqual(
    ready({
      exec: h.exec,
      parsed: { dryRun: false, deferred: [], noDeferred: true },
      ledger: tempLedger(),
    }),
    { number: 56, head, dryRun: false, deferred: 0 },
  )
  assert.equal(
    h.calls.some(
      ([file, args]) =>
        file === 'gh' && args[1] === 'ready' && args[2] === '57',
    ),
    false,
  )
})

test('fails closed for malformed, ambiguous, over-limit, and wrong-head rows', () => {
  const cases = [
    [otherPr(57, 'other/one', { isCrossRepository: undefined })],
    [otherPr(57, 'topic')],
    [
      otherPr(57, 'other/one'),
      otherPr(58, 'other/two'),
      otherPr(59, 'other/three'),
    ],
  ]
  for (const otherPrs of cases) {
    const h = harness({
      body: '## Workflow usage\n\nOptional. No workflow usage was included.',
      otherPrs,
    })
    assert.throws(
      () =>
        ready({
          exec: h.exec,
          parsed: { dryRun: false, deferred: [], noDeferred: true },
          ledger: tempLedger(),
        }),
      /Exactly one open PR for the current branch/u,
    )
  }

  const h = harness({
    body: '## Workflow usage\n\nOptional. No workflow usage was included.',
  })
  const original = h.exec
  h.exec = (file, args, options) => {
    const result = original(file, args, options)
    if (file !== 'gh' || args[1] !== 'list') return result
    const rows = JSON.parse(result)
    rows[0].headRefName = 'other/head'
    return JSON.stringify(rows)
  }
  assert.throws(
    () =>
      ready({
        exec: h.exec,
        parsed: { dryRun: false, deferred: [], noDeferred: true },
        ledger: tempLedger(),
      }),
    /Exactly one open PR for the current branch/u,
  )
})

test('requires a sanitized report when the PR body has a usage block', () => {
  const h = harness()
  assert.throws(
    () =>
      ready({
        exec: h.exec,
        parsed: { dryRun: false, deferred: [], noDeferred: true },
        ledger: tempLedger(),
      }),
    /marker block requires a sanitized task usage report/u,
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
  partial.rows[0].requestedModel = null
  partial.rows[0].requestedEffort = null
  partial.rows[0].reportedEffort = null
  partial.rows[0].reportedModels = []
  partial.rows[0].coverageReasons = [
    'measurement_unresolved',
    'duration_unavailable',
    'usage_unavailable',
    'usage_source_unavailable',
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

test('rejects every not-ready reason when it appears on a row', () => {
  for (const reason of [
    'task_inventory_not_sealed',
    'no_registered_executions',
    'execution_active',
  ]) {
    const path = tempUsageReport()
    const value = JSON.parse(readFileSync(path, 'utf8'))
    value.coverage = { status: 'partial', reasons: ['measurement_unresolved'] }
    value.totals.complete = null
    value.rows[0].coverageReasons = [reason]
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
      /still active or unsealed|sealed inventory and no active executions/u,
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
    /Workflow usage section must contain only|legacy workflow usage table/u,
  )
})

test('rejects a legacy workflow table outside the generated section', () => {
  const reportPath = tempUsageReport()
  const reportMarkdown = JSON.parse(readFileSync(reportPath, 'utf8')).markdown
  const h = harness({
    body: [
      '## Workflow usage',
      '',
      reportMarkdown,
      '',
      '## Notes',
      '',
      '| Execution | Model (requested → reported) | Effort (requested → reported) |',
      '| --- | --- | --- |',
    ].join('\n'),
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
    /legacy workflow usage table/u,
  )
})

test('rejects an unmarked current workflow table outside the generated section', () => {
  const reportPath = tempUsageReport()
  const reportMarkdown = JSON.parse(readFileSync(reportPath, 'utf8')).markdown
  const h = harness({
    body: [
      '## Workflow usage',
      '',
      reportMarkdown,
      '',
      '## Notes',
      '',
      '| Stage | Attempt | Provider | Requested model | Requested effort | Reported effort | Reported models | Outcome | Duration | Usage source | Tokens | Reason |',
      '| --- | ---: | --- | --- | --- | --- | --- | --- | ---: | --- | --- | --- |',
      '| old | 1 | codex | gpt-5.6-sol | medium | medium | gpt-5.6-sol | succeeded | 1 ms | ccusage_interval | 1 in / 1 out / 2 total (cache read 0, cache write 0) | — |',
    ].join('\n'),
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
    /unmarked workflow usage table/u,
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

test('accepts current model identifiers in requested and reported models', () => {
  for (const model of [
    'gpt-6-sol',
    'gpt-6-luna',
    'claude-opus-5-5',
    'claude-fable-5-1',
  ]) {
    const path = tempUsageReport()
    const value = JSON.parse(readFileSync(path, 'utf8'))
    value.rows[0].requestedModel = model
    value.rows[0].reportedModels = [model]
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
  }
})

test('accepts per-invocation usage imported from a factory loop report', () => {
  const path = tempUsageReport()
  const value = JSON.parse(readFileSync(path, 'utf8'))
  value.rows[0].usageSource = 'factory_loop_report'
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

test('rejects complete rows with unavailable sources or row reasons', () => {
  const path = tempUsageReport()
  const value = JSON.parse(readFileSync(path, 'utf8'))
  value.rows[0].usageSource = null
  value.rows[0].coverageReasons = ['usage_source_unavailable']
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
    /complete source, reason, and model metadata/u,
  )
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

test('requires reasons for unknown partial timing totals', () => {
  const path = tempUsageReport()
  const value = JSON.parse(readFileSync(path, 'utf8'))
  value.coverage = { status: 'partial', reasons: ['measurement_unresolved'] }
  value.totals.complete = null
  value.wallElapsedMs = null
  value.invocationDurationMs = null
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
    /wallElapsedMs.*wall_elapsed_unavailable/u,
  )

  value.coverage.reasons.push('wall_elapsed_unavailable')
  value.markdown = renderCanonicalWorkflowUsageMarkdown(value)
  writeFileSync(path, JSON.stringify(value))
  const second = harness({ body: `## Workflow usage\n\n${value.markdown}` })
  assert.throws(
    () =>
      ready({
        exec: second.exec,
        parsed: {
          dryRun: false,
          deferred: [],
          noDeferred: true,
          taskUsageReport: path,
        },
        ledger: tempLedger(),
      }),
    /invocationDurationMs.*invocation_duration_unavailable/u,
  )

  value.wallElapsedMs = 10
  value.invocationDurationMs = 10
  value.coverage.reasons = ['wall_elapsed_unavailable']
  value.markdown = renderCanonicalWorkflowUsageMarkdown(value)
  writeFileSync(path, JSON.stringify(value))
  const known = harness({ body: `## Workflow usage\n\n${value.markdown}` })
  assert.throws(
    () =>
      ready({
        exec: known.exec,
        parsed: {
          dryRun: false,
          deferred: [],
          noDeferred: true,
          taskUsageReport: path,
        },
        ledger: tempLedger(),
      }),
    /wall_elapsed_unavailable.*requires wallElapsedMs to be unknown/u,
  )
})

test('rejects reserved row reasons when their fields are known', () => {
  for (const reason of [
    'usage_unavailable',
    'duration_unavailable',
    'usage_source_unavailable',
    'requested_model_unrecorded',
    'requested_effort_unrecorded',
    'reported_effort_unavailable',
    'reported_models_unavailable',
  ]) {
    const path = tempUsageReport()
    const value = JSON.parse(readFileSync(path, 'utf8'))
    value.coverage = { status: 'partial', reasons: ['measurement_unresolved'] }
    value.totals.complete = null
    value.rows[0].coverageReasons = [reason]
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
      new RegExp(`${reason}.*field is known`, 'u'),
    )
  }
})

test('rejects unsupported nested report properties', () => {
  for (const mutate of [
    (value) => {
      value.coverage.extra = true
    },
    (value) => {
      value.totals.extra = true
    },
    (value) => {
      value.totals.measured.extra = true
    },
    (value) => {
      value.rows[0].usage.extra = true
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
      /not allowed/u,
    )
    assert.equal(
      h.calls.some(([file, args]) => file === 'gh' && args[1] === 'ready'),
      false,
    )
  }
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
      'usage_source_unavailable',
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

test('rejects a partial wall span shorter than a known row duration', () => {
  const path = tempUsageReport()
  const value = JSON.parse(readFileSync(path, 'utf8'))
  value.coverage = { status: 'partial', reasons: ['measurement_unresolved'] }
  value.totals.complete = null
  value.wallElapsedMs = 0
  value.invocationDurationMs = value.rows[0].durationMs
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
    /wall elapsed duration is shorter than a known row/u,
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

test('rejects a case-variant duplicate workflow usage heading', () => {
  const reportPath = tempUsageReport()
  const reportMarkdown = JSON.parse(readFileSync(reportPath, 'utf8')).markdown
  const h = harness({
    body: `## Workflow usage\n\n${reportMarkdown}\n\n## Workflow Usage\n\n| stale | table |\n| --- | --- |`,
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
    /exactly one workflow usage marker block/u,
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
        /pnpm pr:ready -- --ui-gate-complete --no-deferred/u,
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

test('rechecks the PR body before marking it ready', () => {
  const h = harness({
    otherPrs: [otherPr(57, 'other/one'), otherPr(58, 'other/two')],
  })
  const original = h.exec
  let listCalls = 0
  h.exec = (file, args, options) => {
    if (file === 'gh' && args[1] === 'list') {
      listCalls += 1
      const result = original(file, args, options)
      if (listCalls === 2) {
        const rows = JSON.parse(result)
        rows[0].body += '\nchanged before Ready'
        return JSON.stringify(rows)
      }
      return result
    }
    return original(file, args, options)
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
    /changed while Ready was being prepared/u,
  )
  assert.equal(
    h.calls.some(([file, args]) => file === 'gh' && args[1] === 'ready'),
    false,
  )
})

test('reverts Ready when the PR body changes during the mutation', () => {
  const h = harness({
    otherPrs: [otherPr(57, 'other/one'), otherPr(58, 'other/two')],
  })
  const original = h.exec
  let listCalls = 0
  h.exec = (file, args, options) => {
    if (file === 'gh' && args[1] === 'list') {
      listCalls += 1
      const result = original(file, args, options)
      if (listCalls === 3) {
        const rows = JSON.parse(result)
        rows[0].body += '\nchanged after Ready'
        return JSON.stringify(rows)
      }
      return result
    }
    return original(file, args, options)
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
    /changed after Ready; Ready was reverted/u,
  )
  assert.ok(
    h.calls.some(
      ([file, args]) =>
        file === 'gh' &&
        args[1] === 'ready' &&
        args[2] === '56' &&
        args.includes('--undo'),
    ),
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

test('schema 3 renders the complete canonical block with unchanged exact details', () => {
  const report = JSON.parse(readFileSync(tempUsageReport(), 'utf8'))
  assert.equal(
    report.markdown,
    `<!-- artifactshare:workflow-usage:start -->
**Usage:** 1 invocation · <1s wall (<1s in calls) · 2 tokens (0% cache read) · coverage: complete

| Stage | Calls | Model / effort | Time | Tokens |
| --- | ---: | --- | ---: | ---: |
| implementation | 1 | gpt-5.6-sol/medium | <1s | 2 |

<details>
<summary>Per invocation (1), exact totals, and coverage</summary>

**Target commit:** \`${head}\`
**Workflow usage coverage:** complete
**Measured total:** 1 in / 1 out / 2 total (cache read 0, cache write 0)
**Complete total:** 1 in / 1 out / 2 total (cache read 0, cache write 0)
**Wall elapsed:** 10 ms
**Sum of invocation durations:** 10 ms

| Stage | Attempt | Provider | Requested model | Requested effort | Reported effort | Reported models | Outcome | Duration | Usage source | Tokens | Reason |
| --- | ---: | --- | --- | --- | --- | --- | --- | ---: | --- | --- | --- |
| implementation | 1 | codex | gpt-5.6-sol | medium | medium | gpt-5.6-sol | succeeded | 10 ms | ccusage_interval | 1 in / 1 out / 2 total (cache read 0, cache write 0) | — |

</details>
<!-- artifactshare:workflow-usage:end -->
`,
  )
})

test('readable durations and tokens use the specified rounding boundaries', () => {
  const report = JSON.parse(readFileSync(tempUsageReport(), 'utf8'))
  for (const [value, expected] of [
    [0, '0s'],
    [1, '<1s'],
    [499, '<1s'],
    [500, '1s'],
    [59_499, '59s'],
    [59_500, '1m 00s'],
    [60_000, '1m 00s'],
    [3_599_500, '1h 00m'],
    [3_600_000, '1h 00m'],
    [3_630_000, '1h 01m'],
    [7_199_999, '2h 00m'],
    [null, 'unknown'],
  ]) {
    report.wallElapsedMs = value
    report.invocationDurationMs = value
    report.rows[0].durationMs = value
    const markdown = renderCanonicalWorkflowUsageMarkdown(report)
    assert.ok(markdown.includes(`· ${expected} wall (${expected} in calls)`))
    assert.ok(
      markdown.includes(
        `| implementation | 1 | gpt-5.6-sol/medium | ${expected} | 2 |`,
      ),
    )
  }
  for (const [value, expected] of [
    [999, '999'],
    [1000, '1.0k'],
    [999_949, '999.9k'],
    [999_950, '1.00M'],
  ]) {
    report.totals.measured.totalTokens = value
    report.rows[0].usage.totalTokens = value
    const markdown = renderCanonicalWorkflowUsageMarkdown(report)
    assert.ok(markdown.includes(`· ${expected} tokens (0% cache read)`))
    assert.ok(markdown.includes(`| unknown | ${expected} |`))
  }
})

test('stage rollups preserve first appearance, distinct pairs, and unknown sums', () => {
  const report = JSON.parse(readFileSync(tempUsageReport(), 'utf8'))
  const row = report.rows[0]
  report.rows = [
    { ...row, stage: 'orchestration' },
    { ...row, durationMs: null, usage: null },
    { ...row, stage: 'orchestration', requestedEffort: 'high' },
    { ...row, requestedModel: null },
    { ...row, stage: 'orchestration' },
    { ...row, requestedEffort: null },
    { ...row, requestedModel: null, requestedEffort: null },
  ]
  report.wallElapsedMs = 1000
  report.invocationDurationMs = null
  const markdown = renderCanonicalWorkflowUsageMarkdown(report)
  assert.ok(
    markdown.includes('**Usage:** 7 invocations · 1s wall (unknown in calls)'),
  )
  assert.ok(
    markdown.includes(`| orchestration | 3 | gpt-5.6-sol/medium, gpt-5.6-sol/high | <1s | 6 |
| implementation | 4 | gpt-5.6-sol/medium, unknown/medium, gpt-5.6-sol/unknown, unknown/unknown | unknown | unknown |`),
  )
  assert.ok(
    markdown.includes(
      '<summary>Per invocation (7), exact totals, and coverage</summary>',
    ),
  )
})

test('summary distinguishes missing usage from other partial coverage', () => {
  const report = JSON.parse(readFileSync(tempUsageReport(), 'utf8'))
  report.coverage = { status: 'partial', reasons: ['duration_unavailable'] }
  report.totals.complete = null
  report.totals.measured = {
    rawInputTokens: 2,
    cacheReadInputTokens: 1,
    cacheWriteInputTokens: 0,
    inputTokens: 3,
    outputTokens: 1,
    totalTokens: 4,
  }
  report.rows[0].usage = report.totals.measured
  const render = () => renderCanonicalWorkflowUsageMarkdown(report)
  assert.ok(
    render().includes('· 4 tokens (33% cache read) · coverage: partial'),
  )
  assert.ok(render().includes('**Complete total:** unknown'))
  assert.ok(
    render().includes(
      '\n**Coverage reasons:**\n- duration_unavailable\n\n</details>',
    ),
  )
  report.totals.measured.inputTokens = 0
  assert.ok(render().includes('· 4 tokens · coverage: partial'))
  report.rows.push({ ...report.rows[0], usage: null })
  assert.ok(
    render().includes('· at least 4 tokens (usage unknown for 1 of 2) ·'),
  )
  assert.ok(!render().split('\n')[1].includes('cache read'))
  report.rows[0].usage = null
  report.totals.measured = null
  report.coverage.status = 'unknown'
  assert.ok(render().includes('· unknown tokens · coverage: unknown'))
})

test('stage names and model pair lists use Markdown cell escaping', () => {
  const report = JSON.parse(readFileSync(tempUsageReport(), 'utf8'))
  report.rows[0].stage = 'stage|name\nnext'
  report.rows[0].requestedModel = 'model|name\nnext'
  assert.ok(
    renderCanonicalWorkflowUsageMarkdown(report).includes(
      '| stage\\|name next | 1 | model\\|name next/medium | <1s | 2 |',
    ),
  )
})

test('orchestration passes validation and schema 2 fails before Markdown comparison', () => {
  const path = tempUsageReport()
  const report = JSON.parse(readFileSync(path, 'utf8'))
  report.rows[0].stage = 'orchestration'
  report.markdown = renderCanonicalWorkflowUsageMarkdown(report)
  writeFileSync(path, JSON.stringify(report))
  const h = harness({ body: `## Workflow usage\n\n${report.markdown}` })
  const run = () =>
    ready({
      exec: h.exec,
      parsed: {
        dryRun: true,
        deferred: [],
        noDeferred: true,
        taskUsageReport: path,
      },
      ledger: tempLedger(),
    })
  assert.doesNotThrow(run)
  report.schemaVersion = 2
  report.markdown = 'previous layout'
  writeFileSync(path, JSON.stringify(report))
  assert.throws(run, /Task usage report schema version is unsupported\./u)
})

test('rejects either table outside markers, with stage slash spacing variants', () => {
  const path = tempUsageReport()
  const report = JSON.parse(readFileSync(path, 'utf8'))
  const headers = [
    '| Stage | Attempt | Provider | Requested model | Requested effort | Reported effort | Reported models | Outcome | Duration | Usage source | Tokens | Reason |',
    ...[
      'Model / effort',
      'Model/effort',
      'Model /effort',
      'Model/ effort',
      'Model\t/\teffort',
    ].map((model) => `| Stage | Calls | ${model} | Time | Tokens |`),
  ]
  for (const header of headers.flatMap((value) => [
    value,
    value.slice(0, -1).trimEnd(),
    `${value.slice(0, -1)}\t`,
  ])) {
    for (const body of [
      header,
      `${header}\n\n## Workflow usage\n\n${report.markdown}`,
      `## Workflow usage\n\n${report.markdown}\n## Notes\n${header}`,
    ]) {
      const h = harness({ body })
      assert.throws(
        () =>
          ready({
            exec: h.exec,
            parsed: {
              dryRun: true,
              deferred: [],
              noDeferred: true,
              taskUsageReport: body === header ? undefined : path,
            },
            ledger: tempLedger(),
          }),
        /unmarked workflow usage table/u,
      )
    }
  }
})

test('schema 3 rejects changes to canonical summary, rollup, and details', () => {
  const path = tempUsageReport()
  const report = JSON.parse(readFileSync(path, 'utf8'))
  const canonical = report.markdown
  for (const [before, after] of [
    ['1 invocation ·', '1 invocations ·'],
    ['<1s wall', '10 ms wall'],
    [
      '| implementation | 1 | gpt-5.6-sol/medium | <1s | 2 |',
      '| implementation | 1 | gpt-5.6-sol/medium | <1s | 3 |',
    ],
    ['\n\n<details>', '\n<details>'],
    ['<details>', '<details open>'],
  ]) {
    report.markdown = canonical.replace(before, after)
    writeFileSync(path, JSON.stringify(report))
    const h = harness({ body: `## Workflow usage\n\n${report.markdown}` })
    assert.throws(
      () =>
        ready({
          exec: h.exec,
          parsed: {
            dryRun: true,
            deferred: [],
            noDeferred: true,
            taskUsageReport: path,
          },
          ledger: tempLedger(),
        }),
      /markdown does not match report data/u,
    )
  }
})

test('unknown stage duration and tokens propagate independently', () => {
  const report = JSON.parse(readFileSync(tempUsageReport(), 'utf8'))
  const row = report.rows[0]
  report.rows = [
    { ...row, durationMs: null },
    { ...row, stage: 'orchestration', usage: null },
    row,
    { ...row, stage: 'orchestration' },
  ]
  assert.ok(
    renderCanonicalWorkflowUsageMarkdown(report).includes(
      '| implementation | 2 | gpt-5.6-sol/medium | unknown | 4 |\n| orchestration | 2 | gpt-5.6-sol/medium | <1s | unknown |',
    ),
  )
})

test('another PR blocks Ready and dry runs before checks without changing the ledger', () => {
  for (const dryRun of [false, true]) {
    const ledger = tempLedger()
    const original = JSON.stringify({
      schema_version: 1,
      entries: [
        {
          pr: 4,
          head: 'b'.repeat(40),
          deferred: ['name the select for screen readers'],
        },
      ],
    })
    writeFileSync(ledger, original)
    const h = harness({ body: 'Public body' })
    assert.throws(
      () =>
        ready({
          exec: h.exec,
          ledger,
          parsed: { dryRun, deferred: [], noDeferred: true },
        }),
      {
        message: [
          'A previous change deferred review findings that were never discharged; no write performed.',
          `PR #4 (${'b'.repeat(12)}):`,
          '  - name the select for screen readers',
          'Finish the prior landing cleanup:',
          '  pnpm pr:landed -- --pr <number>',
        ].join('\n'),
      },
    )
    assert.equal(readFileSync(ledger, 'utf8'), original)
    assert.equal(
      h.calls.filter(
        ([file, args]) =>
          file === 'gh' && ['checks', 'ready'].includes(args[1]),
      ).length,
      0,
    )
    assert.equal(
      h.calls.some(([file, args]) => file === 'gh' && args[1] === 'list'),
      true,
    )
  }
})

test('repeated Ready keeps its own accumulated deferred findings', () => {
  const ledger = tempLedger()
  writeFileSync(
    ledger,
    JSON.stringify({
      schema_version: 1,
      entries: [
        {
          pr: 56,
          head,
          deferred: ['name the select for screen readers'],
        },
      ],
    }),
  )
  const h = harness({ body: 'Public body' })
  ready({
    exec: h.exec,
    ledger,
    parsed: parseArgs(['--deferred', 'document keyboard navigation']),
  })
  assert.deepEqual(
    JSON.parse(readFileSync(ledger, 'utf8')).entries[0].deferred,
    ['name the select for screen readers', 'document keyboard navigation'],
  )
  assert.equal(
    h.calls.some(([file, args]) => file === 'gh' && args[1] === 'ready'),
    true,
  )
})

test('dry-run refuses an unreadable ledger before querying checks', () => {
  const ledger = tempLedger()
  writeFileSync(ledger, '{ truncated')
  const h = harness({ body: 'Public body' })
  assert.throws(
    () =>
      ready({
        exec: h.exec,
        ledger,
        parsed: parseArgs(['--dry-run', '--no-deferred']),
      }),
    /could not be read; Ready was not changed/u,
  )
  assert.equal(readFileSync(ledger, 'utf8'), '{ truncated')
  assert.equal(
    h.calls.some(([file, args]) => file === 'gh' && args[1] === 'checks'),
    false,
  )
})

test('Ready coordinator orders locking, Ready, queue, and cleanup with the same ledger', async () => {
  const events = []
  const h = harness({ body: 'Public body' })
  const ledger = tempLedger()
  const logs = []
  const code = await runReady({
    parsed: parseArgs(['--', '--no-deferred', '--queue']),
    ledger,
    exec: (file, args) => {
      if (file === 'gh' && args[1] === 'ready') events.push('ready')
      return h.exec(file, args)
    },
    acquireLock: (path, options) => {
      assert.equal(path, `${ledger}.lock`)
      assert.equal(options.wait, true)
      assert.equal(options.acquireTimeoutMs, 600_000)
      assert.equal(typeof options.onContention, 'function')
      events.push('lock')
      return () => events.push('release')
    },
    queueFlow: ({ args, log }) => {
      assert.deepEqual(args, ['--pr', '56'])
      events.push('queue')
      log('Queue merged')
      return Promise.resolve({ kind: 'merged', pr: 56 })
    },
    landedFlow: ({ parsed, ledger: path }) => {
      assert.deepEqual(parsed, { pr: 56, dryRun: false })
      assert.equal(path, ledger)
      events.push('landed')
      return {
        pr: 56,
        state: 'MERGED',
        releasedDeferred: 0,
        notes: ['Cleanup complete'],
        problems: [],
        exitCode: 0,
      }
    },
    log: (line) => logs.push(line),
    reportError: assert.fail,
  })
  assert.equal(code, 0)
  assert.deepEqual(events, ['lock', 'ready', 'release', 'queue', 'landed'])
  assert.ok(logs.includes('Queue merged'))
  assert.ok(logs.includes('  Cleanup complete'))
})

test('queue and cleanup failures retain diagnostics and propagate nonzero status', async () => {
  for (const failure of ['returned', 'thrown', 'cleanup', 'cleanup-thrown']) {
    const h = harness({ body: 'Public body' })
    const messages = []
    let cleanupCalls = 0
    const code = await runReady({
      parsed: parseArgs(['--no-deferred', '--queue']),
      ledger: tempLedger(),
      exec: h.exec,
      acquireLock: () => () => {},
      queueFlow: ({ log }) => {
        if (failure === 'thrown')
          return Promise.reject(new Error('Queue timed out'))
        if (failure === 'returned') {
          log('Queue failed: test job')
          return Promise.resolve({ kind: 'failed' })
        }
        return { kind: 'merged' }
      },
      landedFlow: () => {
        cleanupCalls += 1
        if (failure === 'cleanup-thrown') throw new Error('Cleanup refused')
        return {
          pr: 56,
          state: 'MERGED',
          releasedDeferred: 0,
          notes: ['Ledger settled'],
          problems: ['Checkout is dirty'],
          exitCode: 1,
        }
      },
      log: (line) => messages.push(line),
      reportError: (line) => messages.push(line),
    })
    assert.equal(code, 1)
    assert.equal(cleanupCalls, failure.startsWith('cleanup') ? 1 : 0)
    assert.match(
      messages.join('\n'),
      {
        returned: /Queue failed: test job/u,
        thrown: /Queue timed out/u,
        cleanup: /local cleanup did not finish: Checkout is dirty/u,
        'cleanup-thrown': /Cleanup refused/u,
      }[failure],
    )
    assert.deepEqual(
      h.calls.filter(([file, args]) => file === 'gh' && args[1] === 'ready'),
      [['gh', ['pr', 'ready', '56']]],
    )
  }
})

test('failed Ready, dry-run, and Ready without queue never start queue or cleanup', async () => {
  for (const mode of ['failed', 'post-check-failed', 'dry-run', 'plain']) {
    const h = harness({ body: 'Public body', dirty: mode === 'failed' })
    let mutated = false
    const code = await runReady({
      parsed: parseArgs([
        '--no-deferred',
        ...(mode === 'plain' ? [] : ['--queue']),
        ...(mode === 'dry-run' ? ['--dry-run'] : []),
      ]),
      ledger: tempLedger(),
      exec: (file, args) => {
        if (
          mode === 'post-check-failed' &&
          mutated &&
          file === 'gh' &&
          args[1] === 'list'
        )
          throw new Error('PR query failed')
        if (file === 'gh' && args[1] === 'ready') mutated = true
        return h.exec(file, args)
      },
      acquireLock: () => () => {},
      queueFlow: assert.fail,
      landedFlow: assert.fail,
      log: () => {},
      reportError: () => {},
    })
    assert.equal(code, mode.includes('failed') ? 1 : 0)
    if (mode === 'dry-run') assert.equal(mutated, false)
  }
})

test('concurrent Ready reads the winning findings only after release', async () => {
  const ledger = tempLedger()
  const releasing = Promise.withResolvers()
  const secondGate = Promise.withResolvers()
  const wrote = Promise.withResolvers()
  const first = runReady({
    ledger,
    parsed: parseArgs(['--deferred', 'winning finding']),
    exec: harness({ body: 'Public body' }).exec,
    acquireLock: () => () => {
      wrote.resolve()
      return releasing.promise
    },
    log: () => {},
    reportError: assert.fail,
  })
  await wrote.promise
  const winner = readFileSync(ledger, 'utf8')
  const secondHarness = harness({ body: 'Public body' })
  const errors = []
  const second = runReady({
    ledger,
    parsed: parseArgs(['--no-deferred']),
    exec: (file, args) => {
      const value = secondHarness.exec(file, args)
      if (file === 'gh' && args[1] === 'list')
        return JSON.stringify(
          JSON.parse(value).map((row) => ({ ...row, number: 57 })),
        )
      return value
    },
    acquireLock: () => secondGate.promise,
    log: () => {},
    reportError: (line) => errors.push(line),
  })
  assert.deepEqual(secondHarness.calls, [])
  releasing.resolve()
  assert.equal(await first, 0)
  secondGate.resolve(() => {})
  assert.equal(await second, 1)
  assert.match(errors.join('\n'), /never discharged/u)
  assert.equal(readFileSync(ledger, 'utf8'), winner)
})

for (const mode of ['immediate', 'contended', 'timeout', 'dry']) {
  test(`Ready lock: ${mode}`, async () => {
    const h = harness({ body: 'Public body' })
    const ledger = tempLedger()
    const gate = Promise.withResolvers()
    const logs = []
    const errors = []
    let released = false
    const pending = runReady({
      ledger,
      exec: h.exec,
      parsed: parseArgs([
        '--no-deferred',
        ...(mode === 'dry' ? ['--dry-run'] : []),
      ]),
      acquireLock: (path, options) => {
        assert.equal(path, `${ledger}.lock`)
        assert.equal(options.acquireTimeoutMs, 600_000)
        if (['contended', 'timeout'].includes(mode)) options.onContention()
        return gate.promise
      },
      log: (line) => logs.push(line),
      reportError: (line) => errors.push(line),
    })
    assert.deepEqual(h.calls, [])
    if (mode === 'timeout')
      gate.reject(Object.assign(new Error('timeout'), { code: 'LOCK_TIMEOUT' }))
    else
      gate.resolve(() => {
        released = true
      })
    assert.equal(await pending, mode === 'timeout' ? 1 : 0)
    assert.equal(
      logs.filter((line) => line.startsWith('Waiting')).length,
      ['contended', 'timeout'].includes(mode) ? 1 : 0,
    )
    if (mode === 'timeout') {
      assert.deepEqual(h.calls, [])
      assert.ok(errors[0].includes(`${ledger}.lock`))
      assert.match(errors[0], /lsof /u)
    } else assert.equal(released, true)
    if (['timeout', 'dry'].includes(mode))
      assert.throws(() => readFileSync(ledger), { code: 'ENOENT' })
  })
}

test('queue merge reacquires landing lock and reports recovery on timeout', async () => {
  for (const timeout of [false, true]) {
    const ledger = tempLedger()
    const h = harness({ body: 'Public body' })
    const events = []
    const errors = []
    let locks = 0
    const code = await runReady({
      ledger,
      parsed: parseArgs(['--deferred', 'finding', '--queue']),
      exec: (file, args) => {
        if (file === 'gh' && args[1] === 'view')
          return JSON.stringify({ state: 'MERGED', headRefName: 'main' })
        if (locks === 2 && file === 'git') {
          assert.equal(events.at(-1), 'release')
          throw new Error('synthetic checkout failure')
        }
        return h.exec(file, args)
      },
      acquireLock: (path) => {
        assert.equal(path, `${ledger}.lock`)
        locks++
        events.push('acquire')
        if (locks === 2 && timeout)
          throw Object.assign(new Error('timeout'), { code: 'LOCK_TIMEOUT' })
        return () => events.push('release')
      },
      queueFlow: () => {
        assert.equal(events.at(-1), 'release')
        events.push('queue')
        return { kind: 'merged' }
      },
      log: () => {},
      reportError: (line) => errors.push(line),
    })
    assert.equal(code, 1)
    assert.deepEqual(
      events,
      timeout
        ? ['acquire', 'release', 'queue', 'acquire']
        : ['acquire', 'release', 'queue', 'acquire', 'release'],
    )
    const entries = JSON.parse(readFileSync(ledger, 'utf8')).entries
    assert.equal(entries.length, timeout ? 1 : 0)
    if (timeout) {
      assert.match(errors[0], /lsof /u)
      assert.match(errors[1], /rerun pnpm pr:landed/u)
      assert.equal(errors.length, 2)
      assert.match(errors.join('\n'), /rerun pnpm pr:landed -- --pr 56/u)
    }
  }
})

test('dry Ready checks the ledger snapshot obtained after acquisition', async () => {
  const ledger = tempLedger()
  const gate = Promise.withResolvers()
  const h = harness({ body: 'Public body' })
  const errors = []
  let released = false
  const pending = runReady({
    ledger,
    parsed: parseArgs(['--no-deferred', '--dry-run']),
    exec: h.exec,
    acquireLock: () => gate.promise,
    log: () => {},
    reportError: (line) => errors.push(line),
  })
  const { readLedger, recordDeferred, writeLedgerAtomic } =
    await import('./landing-ledger.mjs')
  writeLedgerAtomic(
    ledger,
    recordDeferred(readLedger(ledger), {
      pr: 57,
      head,
      deferred: ['written while waiting'],
    }),
  )
  const before = readFileSync(ledger, 'utf8')
  gate.resolve(() => {
    released = true
  })
  assert.equal(await pending, 1)
  assert.equal(released, true)
  assert.match(errors.join('\n'), /never discharged/u)
  assert.equal(readFileSync(ledger, 'utf8'), before)
  assert.ok(
    !h.calls.some(([file, args]) => file === 'gh' && args[1] === 'ready'),
  )
})

for (const dirty of [false, true]) {
  test(`Ready reports its outcome before release failure (dirty=${dirty})`, async () => {
    const h = harness({ body: 'Public body', dirty })
    const ledger = tempLedger()
    const messages = []
    const code = await runReady({
      parsed: parseArgs(['--deferred', 'synthetic finding', '--queue']),
      ledger,
      exec: h.exec,
      acquireLock: () => () => {
        return Promise.reject(new Error('synthetic release failure'))
      },
      queueFlow: assert.fail,
      landedFlow: assert.fail,
      log: (line) => messages.push(line),
      reportError: (line) => messages.push(line),
    })
    assert.equal(code, 1)
    assert.equal(messages.length, 2)
    assert.match(
      messages[1],
      /Ready-lock release failed: synthetic release failure/u,
    )
    if (dirty) {
      assert.match(messages[0], /clean/u)
      assert.ok(
        !h.calls.some(([file, args]) => file === 'gh' && args[1] === 'ready'),
      )
    } else {
      assert.match(messages[0], /^Marked PR #\d+ ready at /u)
      assert.ok(
        h.calls.some(([file, args]) => file === 'gh' && args[1] === 'ready'),
      )
      assert.deepEqual(readLandingLedger(ledger).entries[0].deferred, [
        'synthetic finding',
      ])
    }
  })
}

for (const cleanupFails of [false, true]) {
  test(`queued landing separates release and checkout failures (${cleanupFails})`, async () => {
    const ledger = tempLedger()
    const h = harness({ body: 'Public body' })
    const messages = []
    const rendered = []
    let cleanupResult
    let locks = 0
    const code = await runReady({
      ledger,
      parsed: parseArgs(['--no-deferred', '--queue']),
      exec: (file, args) => {
        if (file === 'gh' && args[1] === 'view')
          return JSON.stringify({ state: 'MERGED', headRefName: 'main' })
        if (locks === 2 && file === 'git') {
          if (cleanupFails) throw new Error('Checkout is dirty')
          return ''
        }
        return h.exec(file, args)
      },
      acquireLock: () => {
        locks++
        return () => {
          if (locks === 2) throw new Error('release failed')
        }
      },
      queueFlow: () => ({ kind: 'merged' }),
      landedFlow: async (options) => {
        cleanupResult = await landed(options)
        return cleanupResult
      },
      log: (line) => {
        messages.push(line)
        rendered.push(['stdout', line])
      },
      reportError: (line) => {
        messages.push(line)
        rendered.push(['stderr', line])
      },
    })
    assert.equal(code, 1)
    const manual = []
    renderLandedResult(cleanupResult, {
      log: (line) => manual.push(['stdout', line]),
      reportError: (line) => manual.push(['stderr', line]),
    })
    assert.deepEqual(rendered.slice(-manual.length), manual)
    assert.deepEqual(
      rendered.filter(([stream]) => stream === 'stderr'),
      [['stderr', cleanupResult.lockReleaseError]],
    )
    const text = messages.join('\n')
    assert.ok(
      text.includes(
        `Landing-lock release failed: release failed; find the holder with: lsof '${ledger}.lock'`,
      ),
    )
    assert.ok(text.includes(`lsof '${ledger}.lock'`))
    assert.ok(!text.includes('local cleanup did not finish: Landing-lock'))
    assert.equal(
      text.includes('local cleanup did not finish: Checkout is dirty'),
      cleanupFails,
    )
    assert.equal(
      text.includes('The ledger is settled; rerun once the checkout is clean.'),
      cleanupFails,
    )
  })
}
