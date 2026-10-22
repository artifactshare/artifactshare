import assert from 'node:assert/strict'
import fs from 'node:fs'
import childProcess from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'
import {
  inspectTree,
  loadBoundaryManifest,
} from './public-development-guard.mjs'
import { deployContentCutover } from './deploy-content-cutover.mjs'
import {
  readContentDeliveryStage,
  verifyContentCutover,
} from './verify-content-cutover.mjs'
import test from 'node:test'
import { unstable_readConfig } from 'wrangler'
import YAML from 'yaml'

function config(file, env) {
  return unstable_readConfig(
    { config: `apps/web/${file}`, ...(env ? { env } : {}) },
    { hideWarnings: true },
  )
}

const app = config('wrangler.production.jsonc')
const alerts = config('wrangler.alerts.jsonc', 'production')
const ogImage = config('wrangler.og-image.jsonc', 'production')
const sandbox = config('wrangler.sandbox.jsonc', 'production')
const previewApp = config('wrangler.jsonc')
const previewSandbox = config('wrangler.sandbox.jsonc')
const webPackage = JSON.parse(fs.readFileSync('apps/web/package.json', 'utf8'))
const workflowSource = fs.readFileSync(
  '.github/workflows/deploy-production.yml',
  'utf8',
)
const workflow = YAML.parse(workflowSource)

test('content deployment scripts are explicitly inside the public boundary', () => {
  const boundary = loadBoundaryManifest()
  const files = [
    'scripts/deploy-content-cutover.mjs',
    'scripts/verify-content-cutover.mjs',
  ]
  const classified = inspectTree(
    files.map((path) => ({ path, mode: 'file' })),
    boundary,
  )
  assert.deepEqual(
    classified.map(({ classification }) => classification),
    ['canonical', 'canonical'],
  )
  assert.throws(
    () =>
      inspectTree(
        [{ path: 'scripts/unclassified-deployment.mjs', mode: 'file' }],
        boundary,
      ),
    /manifest outside path/u,
  )
})

test('default deployment runner invokes only the ordered Wrangler commands and propagates failure', async (t) => {
  for (const stage of ['refuse', 'usercontent']) {
    const expected = [
      ...(stage === 'usercontent'
        ? []
        : [['--var', 'ARTIFACT_DELIVERY_STAGE:refuse']]),
      ['-c', 'wrangler.sandbox.jsonc', '--env', 'production'],
      ['--var', 'ARTIFACT_DELIVERY_STAGE:usercontent'],
    ].map((args) => ['exec', 'wrangler', 'deploy', ...args])
    for (const failure of [null, 'status', 'signal', 'error']) {
      const calls = []
      const mocked = t.mock.method(
        childProcess,
        'spawnSync',
        (command, args, options) => {
          calls.push(args)
          assert.equal(command, 'pnpm')
          assert.deepEqual(options, {
            stdio: 'inherit',
            env: { ...process.env, WRANGLER_LOG_PATH: '../../.wrangler/logs' },
          })
          if (failure === 'error') return { error: new Error('spawn failed') }
          if (failure === 'signal') return { status: null, signal: 'SIGTERM' }
          return { status: failure === 'status' ? 1 : 0 }
        },
      )
      syncBuiltinESMExports()
      try {
        const result = deployContentCutover({
          readStage: () => stage,
          verify: () => {},
        })
        if (failure) await assert.rejects(result, /Content deployment failed/u)
        else await result
        assert.deepEqual(calls, failure ? expected.slice(0, 1) : expected)
      } finally {
        mocked.mock.restore()
        syncBuiltinESMExports()
      }
    }
  }
})

test('production configs preserve the four public Worker entrypoints', () => {
  assert.match(app.main, /\/workers\/app\.ts$/u)
  assert.match(alerts.main, /\/workers\/alerts\.ts$/u)
  assert.match(ogImage.main, /\/workers\/og-image\.ts$/u)
  assert.match(sandbox.main, /\/workers\/sandbox\.ts$/u)
  for (const worker of [app, alerts, ogImage, sandbox]) {
    assert.equal(worker.vars.APP_ENV, 'production')
    assert.ok(worker.name)
  }
})

test('production app and sandbox share D1 and artifact storage', () => {
  assert.equal(app.d1_databases[0].binding, 'DB')
  assert.equal(sandbox.d1_databases[0].binding, 'DB')
  assert.equal(
    app.d1_databases[0].database_id,
    sandbox.d1_databases[0].database_id,
  )
  assert.equal(app.r2_buckets[0].binding, 'BUCKET')
  assert.equal(app.r2_buckets[0].bucket_name, sandbox.r2_buckets[0].bucket_name)
  assert.equal(app.services[0].service, ogImage.name)
  assert.equal(app.tail_consumers[0].service, alerts.name)
})

test('app and sandbox logs redact credential query strings in every environment', () => {
  for (const worker of [app, sandbox, previewApp, previewSandbox]) {
    assert.equal(worker.observability.redact_query_string, true)
  }
})

test('production deployment keeps migration and Workers in one order', () => {
  const command = webPackage.scripts['deploy:production']
  const expectedOrder = [
    'build:production',
    'build:alerts:production',
    'build:og-image:production',
    'build:sandbox:production',
    'db:apply:remote:production',
    'wrangler.alerts.jsonc --env production',
    'wrangler.og-image.jsonc --env production',
    'node ../../scripts/deploy-content-cutover.mjs',
  ]
  let cursor = -1
  for (const marker of expectedOrder) {
    const next = command.indexOf(marker, cursor + 1)
    assert.ok(next > cursor, `deployment marker out of order: ${marker}`)
    cursor = next
  }
  assert.doesNotMatch(
    command,
    /wrangler deploy -c wrangler\.production\.jsonc/u,
  )
})

test('production workflow deploys only production inputs from main', () => {
  assert.ok(workflow.on.workflow_dispatch)
  assert.deepEqual(workflow.on.push, {
    branches: ['main'],
    paths: [
      'apps/web/**',
      'package.json',
      'pnpm-lock.yaml',
      'pnpm-workspace.yaml',
    ],
  })
  assert.equal(workflow.on.pull_request, undefined)
  assert.equal(workflow.on.workflow_dispatch.inputs.mode.default, 'shadow')
  assert.equal(workflow.on.workflow_dispatch.inputs.expected_sha.required, true)
  assert.equal(workflow.on.workflow_dispatch.inputs.expected_sha.type, 'string')
  assert.deepEqual(workflow.on.workflow_dispatch.inputs.mode.options, [
    'shadow',
    'deploy',
  ])
  assert.doesNotMatch(
    JSON.stringify(workflow.jobs.shadow),
    /secrets\.|environment/u,
  )
  assert.match(
    workflowSource,
    /EXPECTED_SHA: \$\{\{ inputs\.expected_sha \}\}[\s\S]*test "\$EXPECTED_SHA" = "\$GITHUB_SHA"[\s\S]*Verify the exact merge-queue validated SHA/u,
  )
  assert.match(
    workflowSource,
    /GITHUB_TOKEN: \$\{\{ github\.token \}\}[\s\S]*verify-validated-sha\.mjs "\$\{\{ github\.sha \}\}"/u,
  )
  for (const jobName of ['shadow', 'deploy']) {
    const setup = workflow.jobs[jobName].steps.find((step) =>
      step.uses?.startsWith('pnpm/action-setup@'),
    )
    assert.ok(setup)
    assert.equal(setup.with?.version, undefined)
  }
})

test('production workflow exposes readable run, job, and result summaries', () => {
  assert.equal(workflow.name, 'Deploy production')
  assert.match(workflow['run-name'], /^Production /u)
  assert.equal(workflow.jobs.shadow.name, 'Validate production build')
  assert.equal(workflow.jobs.deploy.name, 'Deploy and verify production')
  assert.match(workflowSource, /GITHUB_STEP_SUMMARY/gu)
  assert.match(workflowSource, /Production build validated/u)
  assert.match(workflowSource, /Production deployment verified/u)
})

test('production writes require the protected environment', () => {
  assert.deepEqual(workflow.jobs.deploy.environment, {
    name: 'production',
    url: 'https://artifactshare.com',
  })
  assert.equal(workflow.jobs.deploy.needs, 'shadow')
  assert.equal(
    workflow.jobs.deploy.if,
    "github.event_name == 'push' || inputs.mode == 'deploy'",
  )
  assert.match(
    JSON.stringify(workflow.jobs.deploy),
    /secrets\.CLOUDFLARE_API_TOKEN/u,
  )
  assert.deepEqual(
    [...workflowSource.matchAll(/secrets\.([A-Z0-9_]+)/gu)].map(
      (match) => match[1],
    ),
    ['CLOUDFLARE_API_TOKEN'],
  )
  assert.equal(workflow.concurrency['cancel-in-progress'], false)
})

test('workflow dispatch exposes only build and deploy modes', () => {
  const inputs = workflow.on.workflow_dispatch.inputs
  assert.deepEqual(Object.keys(inputs).sort(), ['expected_sha', 'mode'])
  assert.deepEqual(Object.keys(workflow.jobs).sort(), ['deploy', 'shadow'])
})

test('production deploy verifies the complete public origin with retries', () => {
  const deploy = JSON.stringify(workflow.jobs.deploy)
  assert.match(
    deploy,
    /node scripts\/verify-production-origin\.mjs --retries 2 --retry-delay-ms 15000/u,
  )
  assert.doesNotMatch(deploy, /curl|sleep 30/u)
})

test('new content route and fail-closed app default are deployment owned', () => {
  assert.ok(
    sandbox.routes.some(
      (route) =>
        route.pattern === '*.artifactshareusercontent.com/*' &&
        route.zone_name === 'artifactshareusercontent.com',
    ),
  )
  assert.ok(
    sandbox.routes.some(
      (route) => route.pattern === '*.sandbox.artifactshare.com/*',
    ),
  )
  assert.ok(
    app.routes.some((route) => route.pattern === '*.artifactshare.link/*'),
  )
  assert.equal(app.vars.ARTIFACT_DELIVERY_STAGE, 'refuse')
})

for (const initialStage of ['refuse', 'usercontent', 'unknown']) {
  test(`cutover orders deployments and aborts every failure from ${initialStage}`, async () => {
    const expected = [
      ...(initialStage === 'usercontent'
        ? []
        : [
            ['deploy', '--var', 'ARTIFACT_DELIVERY_STAGE:refuse'],
            ['verify', 'app-refusal'],
          ]),
      ['deploy', '-c', 'wrangler.sandbox.jsonc', '--env', 'production'],
      ['verify', 'sandbox-ready'],
      ['deploy', '--var', 'ARTIFACT_DELIVERY_STAGE:usercontent'],
    ]
    for (let failure = -1; failure < expected.length; failure++) {
      const calls = []
      const logs = []
      const record = (call) => {
        calls.push(call)
        if (calls.length - 1 === failure) throw new Error('stage failed')
      }
      const result = deployContentCutover({
        readStage: () => initialStage,
        run: (args) => record(['deploy', ...args]),
        verify: (stage) => record(['verify', stage]),
        log: (...args) => logs.push(args),
      })
      if (failure === -1) await result
      else await assert.rejects(result, /stage failed/u)
      assert.deepEqual(
        calls,
        failure === -1 ? expected : expected.slice(0, failure + 1),
      )
      assert.deepEqual(logs, [
        [
          'Content deployment path',
          {
            path:
              initialStage === 'usercontent' ? 'steady-state' : 'transition',
          },
        ],
      ])
    }
  })
}

test('stage discovery accepts only an exact uncached successful response', async () => {
  for (const [status, body, expected] of [
    [200, 'usercontent', 'usercontent'],
    [200, 'refuse', 'refuse'],
    [404, 'usercontent', 'refuse'],
  ]) {
    const logs = []
    assert.equal(
      await readContentDeliveryStage(
        (url, init) => {
          assert.equal(
            url,
            'https://artifactshare.com/__artifactshare_delivery_stage',
          )
          assert.equal(init.redirect, 'manual')
          assert.equal(init.cache, 'no-store')
          assert.ok(init.signal)
          return new Response(body, { status })
        },
        (...args) => logs.push(args),
      ),
      expected,
    )
    assert.deepEqual(logs, [
      ['Content delivery stage check', { status, stage: expected }],
    ])
  }
  for (const [status, body] of [
    [200, '<html>usercontent</html>'],
    [200, ''],
    [200, 'usercontent\n'],
    [200, '{}'],
    ...[201, 301, 302, 307, 308, 401, 403, 429, 500, 502, 503].map(
      (responseStatus) => [responseStatus, 'usercontent'],
    ),
  ]) {
    const writes = []
    await assert.rejects(
      deployContentCutover({
        readStage: () =>
          readContentDeliveryStage(() => new Response(body, { status })),
        run: (args) => writes.push(args),
        verify: () => writes.push('verify'),
      }),
      /Content delivery stage check/u,
    )
    assert.deepEqual(writes, [])
  }
  const calls = []
  await assert.rejects(
    deployContentCutover({
      readStage: () =>
        readContentDeliveryStage(() => {
          throw new Error('offline')
        }),
      run: (args) => calls.push(args),
    }),
    /offline/u,
  )
  assert.deepEqual(calls, [])
})

test('readiness requires both new kinds, cross-site probe policy, and legacy refusal', async () => {
  const seen = []
  const success = (url, init) => {
    seen.push(url)
    const probe = url.includes('.artifactshareusercontent.com/')
    return new Response(
      probe ? 'artifactshare-sandbox-probe-v1' : 'Not found',
      {
        status: probe ? 200 : 404,
        headers: probe
          ? {
              'X-ArtifactShare-Sandbox-Probe': 'artifactshare-sandbox-probe-v1',
              'Cross-Origin-Resource-Policy': 'cross-origin',
              'Access-Control-Allow-Origin': init.headers.Origin,
            }
          : {},
      },
    )
  }
  await verifyContentCutover('sandbox-ready', success)
  assert.equal(seen.length, 10)
  for (const failedUrl of seen.slice()) {
    await assert.rejects(
      verifyContentCutover('sandbox-ready', (url, init) =>
        url === failedUrl
          ? new Response('unavailable', { status: 503 })
          : success(url, init),
      ),
    )
  }
  await assert.rejects(
    verifyContentCutover('sandbox-ready', () => new Response('legacy content')),
  )
})
