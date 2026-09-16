import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import YAML from 'yaml'
import {
  FAILURE_CLASSIFICATIONS,
  FETCH_TIMEOUT_MS,
  QUERY_ID,
  QUERY_WINDOW_MS,
  WORKER_NAMES,
  formatProbeResults,
  probeObservabilityToken,
  runCli,
} from './probe-observability-token.mjs'

const SCRIPT_PATH = fileURLToPath(
  new URL('./probe-observability-token.mjs', import.meta.url),
)
const TOKEN = 'fake-observability-credential'
const ACCOUNT_ID = '91ff95bcb91fbfa1b1c5c356262b1fe4'
const NOW = 1_800_000_000_000

function environment(overrides = {}) {
  return {
    CLOUDFLARE_API_TOKEN: TOKEN,
    CLOUDFLARE_ACCOUNT_ID: ACCOUNT_ID,
    ...overrides,
  }
}

function response(result = { run: {}, calculations: [] }) {
  return Response.json({
    success: true,
    errors: [],
    messages: [],
    result,
  })
}

function errorResponse(status) {
  return new Response(`response contains ${TOKEN}`, { status })
}

test('probes only the two fixed workers with a bounded read-only query', async () => {
  const calls = []
  const results = await probeObservabilityToken({
    env: environment(),
    now: () => NOW,
    fetchImpl: (url, init) => {
      calls.push({ url: String(url), init, body: JSON.parse(init.body) })
      return calls.length === 1
        ? response({ run: {}, calculations: [] })
        : response({
            run: {},
            calculations: [{ alias: 'events', aggregates: [] }],
          })
    },
  })

  assert.deepEqual(
    results.map(({ worker, success }) => ({ worker, success })),
    [
      { worker: 'artifactshare', success: true },
      { worker: 'artifactshare-alerts', success: true },
    ],
  )
  assert.equal(calls.length, 2)
  assert.deepEqual(
    new Set(calls.map(({ body }) => body.parameters.filters[0].value)),
    new Set(WORKER_NAMES),
  )
  for (const { url, init, body } of calls) {
    assert.equal(
      url,
      `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/workers/observability/telemetry/query`,
    )
    assert.equal(init.method, 'POST')
    assert.equal(init.redirect, 'error')
    assert.equal(init.headers.Authorization, `Bearer ${TOKEN}`)
    assert.equal(init.headers['Content-Type'], 'application/json')
    assert.ok(init.signal instanceof AbortSignal)
    assert.equal(init.signal.aborted, false)
    assert.deepEqual(body, {
      queryId: QUERY_ID,
      timeframe: { from: NOW - QUERY_WINDOW_MS, to: NOW },
      dry: true,
      view: 'calculations',
      chartType: 'aggregate',
      parameters: {
        calculations: [{ operator: 'count', alias: 'events' }],
        filterCombination: 'and',
        filters: [
          {
            key: '$metadata.service',
            operation: 'eq',
            type: 'string',
            value: body.parameters.filters[0].value,
          },
        ],
      },
    })
    assert.equal(body.timeframe.to - body.timeframe.from, QUERY_WINDOW_MS)
    assert.equal(body.view, 'calculations')
    assert.equal(body.chartType, 'aggregate')
    assert.equal(body.dry, true)
    assert.equal(body.events, undefined)
    assert.equal(body.logs, undefined)
  }
})

test('rejects missing credentials or malformed account IDs before fetching', async () => {
  for (const invalidEnv of [
    { CLOUDFLARE_API_TOKEN: '' },
    {
      CLOUDFLARE_API_TOKEN: ` ${TOKEN} `,
      CLOUDFLARE_ACCOUNT_ID: 'not-an-account',
    },
    { CLOUDFLARE_ACCOUNT_ID: 'a'.repeat(31) },
    { CLOUDFLARE_ACCOUNT_ID: 'g'.repeat(32) },
  ]) {
    let calls = 0
    const results = await probeObservabilityToken({
      env: environment(invalidEnv),
      now: () => NOW,
      fetchImpl: () => {
        calls += 1
        throw new Error('must not fetch')
      },
    })
    assert.equal(calls, 0)
    assert.deepEqual(
      results.map(({ classification }) => classification),
      [
        FAILURE_CLASSIFICATIONS.CONFIGURATION,
        FAILURE_CLASSIFICATIONS.CONFIGURATION,
      ],
    )
  }
})

test('classifies HTTP failures without reading or exposing response bodies', async () => {
  for (const status of [401, 403]) {
    const results = await probeObservabilityToken({
      env: environment(),
      now: () => NOW,
      fetchImpl: () => errorResponse(status),
    })
    assert.equal(results.length, 2)
    for (const result of results) {
      assert.equal(result.success, false)
      assert.equal(result.status, status)
      assert.equal(
        result.classification,
        status === 401
          ? FAILURE_CLASSIFICATIONS.UNAUTHORIZED
          : FAILURE_CLASSIFICATIONS.FORBIDDEN,
      )
    }
    assert.doesNotMatch(
      formatProbeResults(results),
      /fake-observability-credential/u,
    )
  }
})

test('classifies timeout and redirect-rejection fetch failures safely', async () => {
  const timeoutResults = await probeObservabilityToken({
    env: environment(),
    now: () => NOW,
    fetchImpl: (_url, init) => {
      assert.equal(init.redirect, 'error')
      assert.ok(init.signal instanceof AbortSignal)
      throw Object.assign(new Error(`timed out with ${TOKEN}`), {
        name: 'TimeoutError',
      })
    },
  })
  assert.deepEqual(
    timeoutResults.map(({ classification }) => classification),
    [FAILURE_CLASSIFICATIONS.TIMEOUT, FAILURE_CLASSIFICATIONS.TIMEOUT],
  )

  const redirectResults = await probeObservabilityToken({
    env: environment(),
    now: () => NOW,
    fetchImpl: (_url, init) => {
      assert.equal(init.redirect, 'error')
      throw new TypeError(`redirect contained ${TOKEN}`)
    },
  })
  assert.deepEqual(
    redirectResults.map(({ classification }) => classification),
    [FAILURE_CLASSIFICATIONS.NETWORK, FAILURE_CLASSIFICATIONS.NETWORK],
  )
  assert.doesNotMatch(
    formatProbeResults(redirectResults),
    /fake-observability-credential/u,
  )
  assert.equal(FETCH_TIMEOUT_MS, 15_000)
})

test('fails closed for false success, malformed JSON, error envelopes, and missing result fields', async () => {
  const cases = [
    {
      name: 'false success',
      response: Response.json({ success: false, errors: [] }),
      classification: FAILURE_CLASSIFICATIONS.API_FAILURE,
    },
    {
      name: 'malformed JSON',
      response: new Response('not json'),
      classification: FAILURE_CLASSIFICATIONS.MALFORMED_JSON,
    },
    {
      name: 'nonempty error envelope',
      response: Response.json({
        success: true,
        errors: [{ message: `credential ${TOKEN}` }],
        result: { run: {}, calculations: [] },
      }),
      classification: FAILURE_CLASSIFICATIONS.ERROR_ENVELOPE,
    },
    {
      name: 'malformed error envelope',
      response: Response.json({
        success: true,
        errors: null,
        result: { run: {}, calculations: [] },
      }),
      classification: FAILURE_CLASSIFICATIONS.ERROR_ENVELOPE,
    },
    {
      name: 'missing result',
      response: Response.json({ success: true, errors: [] }),
      classification: FAILURE_CLASSIFICATIONS.MISSING_RESULT,
    },
    {
      name: 'missing run',
      response: Response.json({
        success: true,
        errors: [],
        result: { calculations: [] },
      }),
      classification: FAILURE_CLASSIFICATIONS.MISSING_RUN,
    },
    {
      name: 'missing calculations',
      response: Response.json({
        success: true,
        errors: [],
        result: { run: {} },
      }),
      classification: FAILURE_CLASSIFICATIONS.MISSING_CALCULATIONS,
    },
  ]
  for (const { name, response: fixture, classification } of cases) {
    const results = await probeObservabilityToken({
      env: environment(),
      now: () => NOW,
      fetchImpl: () => fixture.clone(),
    })
    assert.deepEqual(
      results.map(
        ({ classification: resultClassification }) => resultClassification,
      ),
      [classification, classification],
      name,
    )
    assert.doesNotMatch(
      formatProbeResults(results),
      /fake-observability-credential/u,
    )
  }
})

test('CLI tries both workers, emits fixed redacted output, and returns failure', async () => {
  const output = []
  let calls = 0
  const exitCode = await runCli({
    env: environment(),
    now: () => NOW,
    stdout: { write: (chunk) => output.push(chunk) },
    fetchImpl: () => {
      calls += 1
      return calls === 1 ? response() : errorResponse(403)
    },
  })

  assert.equal(calls, 2)
  assert.equal(exitCode, 1)
  assert.equal(
    output.join(''),
    'artifactshare: success\nartifactshare-alerts: failure (HTTP 403; forbidden)\n',
  )
  assert.doesNotMatch(output.join(''), /fake-observability-credential/u)
  assert.doesNotMatch(output.join(''), /91ff95bcb91fbfa1b1c5c356262b1fe4/u)
  assert.doesNotMatch(
    output.join(''),
    /https?:|\b(?:count|rows|result|query)\b/iu,
  )
})

test('CLI guard exits nonzero for configuration failure without a network call', () => {
  const result = spawnSync(process.execPath, [SCRIPT_PATH], {
    encoding: 'utf8',
    env: {
      CLOUDFLARE_API_TOKEN: '',
      CLOUDFLARE_ACCOUNT_ID: ACCOUNT_ID,
    },
  })
  assert.equal(result.status, 1)
  assert.equal(result.stderr, '')
  assert.equal(
    result.stdout,
    'artifactshare: failure (configuration)\n' +
      'artifactshare-alerts: failure (configuration)\n',
  )
  assert.doesNotMatch(
    result.stdout,
    /https?:|91ff95bcb91fbfa1b1c5c356262b1fe4/u,
  )
})

test('workflow is manual, main-only, protected, read-only, and pinned', () => {
  const workflowPath = '.github/workflows/observability-token-probe.yml'
  const workflowText = fs.readFileSync(workflowPath, 'utf8')
  const workflow = YAML.parse(workflowText)
  const flagshipText = fs.readFileSync(
    '.github/workflows/flagship-access-resolve-evidence.yml',
    'utf8',
  )
  const actionRefs = Object.fromEntries(
    [
      ...flagshipText.matchAll(/uses:\s*(actions\/[^@\s]+)@([0-9a-f]{40})/gu),
    ].map(([, action, sha]) => [action, sha]),
  )

  assert.deepEqual(YAML.parseDocument(workflowText).errors, [])
  assert.deepEqual(Object.keys(workflow.on), ['workflow_dispatch'])
  assert.deepEqual(workflow.on.workflow_dispatch.inputs.expected_sha, {
    description: 'Exact validated main SHA approved for this probe run',
    required: true,
    type: 'string',
  })
  assert.deepEqual(workflow.permissions, { actions: 'read', contents: 'read' })
  assert.equal(workflow.jobs.probe.if, "github.ref == 'refs/heads/main'")
  assert.equal(workflow.jobs.probe['timeout-minutes'], 5)
  assert.deepEqual(workflow.jobs.probe.environment, { name: 'production' })
  assert.equal(
    workflow.jobs.probe.steps[0].uses,
    `actions/checkout@${actionRefs['actions/checkout']}`,
  )
  assert.equal(
    workflow.jobs.probe.steps[1].uses,
    `actions/setup-node@${actionRefs['actions/setup-node']}`,
  )

  const expectedStep = workflow.jobs.probe.steps.find((step) =>
    step.name.includes('approved SHA'),
  )
  const verifyStep = workflow.jobs.probe.steps.find((step) =>
    step.name.includes('merge-queue validated SHA'),
  )
  const probeStep = workflow.jobs.probe.steps.find((step) =>
    step.name.includes('Probe Workers Observability'),
  )
  assert.deepEqual(expectedStep.env, {
    EXPECTED_SHA: '${{ inputs.expected_sha }}',
  })
  assert.equal(expectedStep.run, 'test "$EXPECTED_SHA" = "$GITHUB_SHA"')
  assert.doesNotMatch(expectedStep.run, /inputs\.expected_sha/u)
  assert.deepEqual(verifyStep.env, { GITHUB_TOKEN: '${{ github.token }}' })
  assert.equal(
    verifyStep.run,
    'node scripts/verify-validated-sha.mjs "${{ github.sha }}"',
  )
  assert.deepEqual(probeStep.env, {
    CLOUDFLARE_API_TOKEN: '${{ secrets.CLOUDFLARE_API_TOKEN }}',
    CLOUDFLARE_ACCOUNT_ID: ACCOUNT_ID,
  })
  assert.ok(
    workflow.jobs.probe.steps.indexOf(verifyStep) <
      workflow.jobs.probe.steps.indexOf(probeStep),
  )
  assert.deepEqual(
    [...workflowText.matchAll(/secrets\.([A-Z0-9_]+)/gu)].map(
      (match) => match[1],
    ),
    ['CLOUDFLARE_API_TOKEN'],
  )
  assert.doesNotMatch(
    workflowText,
    /schedule:|upload-artifact|pnpm\s+install|wrangler\s+(?:deploy|secret)|npm\s+(?:install|publish)|curl/iu,
  )
})
