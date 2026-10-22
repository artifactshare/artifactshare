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
      ['verify', 'final'],
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
    let fetches = 0
    await assert.rejects(
      deployContentCutover({
        readStage: () =>
          readContentDeliveryStage(() => {
            fetches++
            return new Response(body, { status })
          }),
        run: (args) => writes.push(args),
        verify: () => writes.push('verify'),
      }),
      /Content delivery stage check/u,
    )
    assert.deepEqual(writes, [])
    assert.equal(fetches, 1)
  }
  for (const failure of ['fetch', 'body']) {
    const calls = []
    let fetches = 0
    await assert.rejects(
      deployContentCutover({
        readStage: () =>
          readContentDeliveryStage(() => {
            fetches++
            if (failure === 'fetch') throw new Error('offline')
            return withBody({
              status: 200,
              text: () => Promise.reject(new Error('offline')),
            })
          }),
        run: (args) => calls.push(args),
        verify: () => calls.push('verify'),
      }),
      /offline/u,
    )
    assert.equal(fetches, 1)
    assert.deepEqual(calls, [])
  }
})

for (const chunkSize of [1, 65]) {
  test(`stage discovery rejects oversized bodies in ${chunkSize}-byte chunks without writes`, async () => {
    let fetches = 0
    let reads = 0
    let cancellations = 0
    const writes = []
    const logs = []
    await assert.rejects(
      deployContentCutover({
        readStage: () =>
          readContentDeliveryStage(
            () => {
              fetches++
              return new Response(
                new ReadableStream(
                  {
                    pull(controller) {
                      reads++
                      controller.enqueue(new Uint8Array(chunkSize))
                      if (reads * chunkSize > 128) controller.close()
                    },
                    cancel() {
                      cancellations++
                    },
                  },
                  { highWaterMark: 0 },
                ),
              )
            },
            (...args) => logs.push(args),
          ),
        run: (args) => writes.push(args),
        verify: () => writes.push('verify'),
      }),
      /Content delivery stage check returned a malformed body/u,
    )
    assert.equal(fetches, 1)
    assert.equal(reads, Math.floor(64 / chunkSize) + 1)
    assert.equal(cancellations, 1)
    assert.deepEqual(writes, [])
    assert.deepEqual(logs, [])
  })
}

test('stage discovery cancels a trickling body at its original request deadline', async (t) => {
  const controller = new AbortController()
  t.mock.method(AbortSignal, 'timeout', (ms) => {
    assert.equal(ms, 10_000)
    return controller.signal
  })
  let fetches = 0
  let reads = 0
  let cancellations = 0
  const writes = []
  await assert.rejects(
    deployContentCutover({
      readStage: () =>
        readContentDeliveryStage((_url, init) => {
          fetches++
          assert.equal(init.signal, controller.signal)
          return new Response(
            new ReadableStream(
              {
                pull(stream) {
                  reads++
                  if (reads === 1) {
                    stream.enqueue(new TextEncoder().encode('user'))
                  } else {
                    stream.enqueue(new TextEncoder().encode('content'))
                    controller.abort()
                    if (cancellations === 0) stream.close()
                  }
                },
                cancel() {
                  cancellations++
                },
              },
              { highWaterMark: 0 },
            ),
          )
        }),
      run: (args) => writes.push(args),
      verify: () => writes.push('verify'),
    }),
    { name: 'AbortError' },
  )
  assert.equal(fetches, 1)
  assert.equal(reads, 2)
  assert.equal(cancellations, 1)
  assert.deepEqual(writes, [])
})

// Independent fixtures: never derive expectations from the verifier's requests.
const artifact = 'probe00000'
const version = '70726f6265'
const probeMarker = 'artifactshare-sandbox-probe-v1'
function expectedChecks(stage) {
  const paths = ['/', '/style.css', '/download', '/__artifactshare_probe']
  const hosts = [`${artifact}--v-${version}.artifactshare.link`]
  if (stage !== 'app-refusal')
    hosts.push(`${artifact}--v-${version}.sandbox.artifactshare.com`)
  return [
    ...hosts.flatMap((host) =>
      paths.map((path) => ({ url: `https://${host}${path}`, status: 404 })),
    ),
    ...(stage !== 'app-refusal'
      ? ['a', 'l'].map((kind) => ({
          url: `https://${kind}-${artifact}--v-${version}.artifactshareusercontent.com/__artifactshare_probe`,
          status: 200,
          origin:
            kind === 'a'
              ? 'https://artifactshare.com'
              : `https://${artifact}.artifactshare.link`,
        }))
      : []),
    ...(stage === 'sandbox-ready'
      ? []
      : [
          {
            url: 'https://artifactshare.com/__artifactshare_delivery_stage',
            status: 200,
            deliveryStage: stage === 'app-refusal' ? 'refuse' : 'usercontent',
          },
        ]),
  ]
}
// A lazy reader keeps clock and failure injection at body-consumption time.
function withBody(response) {
  Object.defineProperty(response, 'body', {
    enumerable: true,
    get: () => ({
      getReader: () => {
        let done = false
        return {
          read: async () => {
            if (done) return { done: true }
            done = true
            return {
              done: false,
              value: new TextEncoder().encode(await response.text()),
            }
          },
          cancel: () => Promise.resolve(),
        }
      },
    }),
  })
  return response
}
function passingResponse(check) {
  return withBody({
    status: check.status,
    headers: new Headers(
      check.origin
        ? {
            'X-ArtifactShare-Sandbox-Probe': probeMarker,
            'Cross-Origin-Resource-Policy': 'cross-origin',
            'Access-Control-Allow-Origin': check.origin,
          }
        : {},
    ),
    text: () =>
      Promise.resolve(
        check.deliveryStage ?? (check.origin ? probeMarker : 'Not found'),
      ),
  })
}
function timing(timeoutMs = 5_000) {
  let now = 0
  const timers = new Map()
  const logs = []
  const waits = []
  const caps = []
  const advance = (ms) => {
    now += ms
    for (const [callback, due] of timers) {
      if (due <= now) {
        timers.delete(callback)
        callback()
      }
    }
  }
  return {
    logs,
    waits,
    caps,
    timers,
    advance,
    options: {
      clock: () => now,
      wait: (ms) => {
        waits.push(ms)
        advance(ms)
        return Promise.resolve()
      },
      log: (message, metadata) => logs.push({ message, ...metadata }),
      timeoutMs,
      setTimer: (callback, ms) => {
        caps.push(ms)
        timers.set(callback, now + ms)
        return callback
      },
      clearTimer: (callback) => timers.delete(callback),
    },
  }
}

for (const stage of ['app-refusal', 'sandbox-ready', 'final']) {
  test(`${stage} repeats complete sets immediately and never accumulates passes`, async () => {
    const checks = expectedChecks(stage)
    const time = timing()
    const seen = []
    await verifyContentCutover(
      stage,
      (url, init) => {
        const index = seen.length % checks.length
        const attempt = Math.floor(seen.length / checks.length)
        const check = checks[index]
        assert.equal(url, check.url)
        assert.equal(init.redirect, 'manual')
        assert.ok(init.signal instanceof AbortSignal)
        assert.deepEqual(
          init.headers,
          check.origin ? { Origin: check.origin } : {},
        )
        assert.equal(time.options.clock(), attempt * 2_000)
        seen.push(url)
        const response = passingResponse(check)
        if (
          (attempt === 0 && index === checks.length - 1) ||
          (attempt === 1 && index === 0)
        )
          response.status = 503
        return response
      },
      time.options,
    )
    assert.deepEqual(
      seen,
      Array(3)
        .fill(checks.map(({ url }) => url))
        .flat(),
    )
    assert.deepEqual(time.waits, [2_000, 2_000])
    assert.deepEqual(
      time.logs.map(({ attempt, status }) => [attempt, status]),
      [
        [1, 503],
        [2, 503],
      ],
    )
    assert.equal(time.timers.size, 0)
  })

  test(`${stage} first-attempt success never waits; unknown stage does no I/O`, async () => {
    const time = timing()
    const checks = expectedChecks(stage)
    let calls = 0
    const fetcher = () => passingResponse(checks[calls++])
    await verifyContentCutover(stage, fetcher, time.options)
    assert.equal(calls, checks.length)
    assert.deepEqual(time.waits, [])
    await assert.rejects(
      verifyContentCutover('unsupported', fetcher, time.options),
      /Expected app-refusal, sandbox-ready, or final/u,
    )
    assert.equal(calls, checks.length)
    assert.deepEqual(time.waits, [])
  })

  test(`${stage} preserves every exact expectation through deadline exhaustion`, async () => {
    const checks = expectedChecks(stage)
    for (const check of checks) {
      const mutations = [
        (response) => {
          response.status = 503
        },
        ...(check.origin
          ? [
              (response) => {
                response.status = 201
              },
              (response) => {
                response.text = () => Promise.resolve(`${probeMarker}\n`)
              },
              (response) => {
                response.text = () => Promise.resolve('private response body')
              },
              (response) => {
                response.headers.delete('X-ArtifactShare-Sandbox-Probe')
              },
              (response) => {
                response.headers.set('X-ArtifactShare-Sandbox-Probe', 'wrong')
              },
              (response) => {
                response.headers.delete('Cross-Origin-Resource-Policy')
              },
              (response) => {
                response.headers.set(
                  'Cross-Origin-Resource-Policy',
                  'same-origin',
                )
              },
              (response) => {
                response.headers.delete('Access-Control-Allow-Origin')
              },
              (response) => {
                response.headers.set('Access-Control-Allow-Origin', '*')
              },
              (response) => {
                response.headers.set(
                  'Access-Control-Allow-Origin',
                  'https://wrong.example',
                )
              },
            ]
          : check.deliveryStage
            ? [
                (response) => {
                  response.text = () => Promise.resolve('wrong')
                },
                (response) => {
                  response.text = () =>
                    Promise.resolve(`${check.deliveryStage}\n`)
                },
              ]
            : [
                (response) => {
                  response.headers.set(
                    'X-ArtifactShare-Sandbox-Probe',
                    probeMarker,
                  )
                },
              ]),
      ]
      for (const mutate of mutations) {
        const time = timing()
        let calls = 0
        await assert.rejects(
          verifyContentCutover(
            stage,
            (url) => {
              assert.ok(time.options.clock() < 5_000)
              const expected = checks[calls++ % checks.length]
              assert.equal(url, expected.url)
              const response = passingResponse(expected)
              if (url === check.url) mutate(response)
              return response
            },
            time.options,
          ),
          (error) => {
            assert.ok(
              error.message.startsWith('Content cutover verification failed'),
            )
            assert.ok(
              error.message.includes(
                new URL(check.url).hostname + new URL(check.url).pathname,
              ),
            )
            assert.ok(!error.message.includes('private response body'))
            return true
          },
        )
        assert.equal(calls, checks.length * 3)
        assert.equal(time.options.clock(), 4_000)
        assert.deepEqual(time.waits, [2_000, 2_000])
        assert.equal(time.logs.length, 3)
        for (const [index, log] of time.logs.entries()) {
          assert.equal(log.stage, stage)
          assert.equal(log.attempt, index + 1)
          assert.equal(log.hostname, new URL(check.url).hostname)
          assert.equal(log.path, new URL(check.url).pathname)
          assert.ok(Number.isInteger(log.status))
        }
        assert.ok(!JSON.stringify(time.logs).includes('private response body'))
        assert.equal(time.timers.size, 0)
      }
    }
  })
}

for (const failure of [
  'fetch-reject',
  'body-reject',
  'fetch-stall',
  'body-stall',
  'abort',
  'late-body',
]) {
  test(`bounds and sanitizes ${failure} including body consumption`, async () => {
    const time = timing(25_000)
    const checks = expectedChecks('sandbox-ready')
    let calls = 0
    const signals = []
    let advanceScheduled = false
    const scheduleAdvance = (ms) => {
      if (advanceScheduled) return
      advanceScheduled = true
      queueMicrotask(() => {
        advanceScheduled = false
        time.advance(ms)
      })
    }
    await assert.rejects(
      verifyContentCutover(
        'sandbox-ready',
        (url, init) => {
          assert.ok(time.options.clock() < 25_000)
          calls++
          signals.push(init.signal)
          const reject = () => {
            throw new Error('private transport payload')
          }
          const stall = () => {
            scheduleAdvance(time.caps.at(-1))
            return new Promise(() => {})
          }
          if (failure === 'fetch-reject') return reject()
          if (failure === 'fetch-stall') return stall()
          if (failure === 'abort') {
            const promise = new Promise((_, rejectAbort) =>
              init.signal.addEventListener(
                'abort',
                () => rejectAbort(new Error('private transport payload')),
                { once: true },
              ),
            )
            scheduleAdvance(time.caps.at(-1))
            return promise
          }
          const response = passingResponse(
            checks.find((check) => check.url === url),
          )
          response.text =
            failure === 'body-reject'
              ? reject
              : failure === 'body-stall'
                ? stall
                : () => {
                    scheduleAdvance(25_000)
                    return Promise.resolve(probeMarker)
                  }
          return response
        },
        time.options,
      ),
      (error) => {
        assert.match(error.message, /^Content cutover verification failed/u)
        assert.ok(!error.message.includes('private transport payload'))
        return true
      },
    )
    assert.equal(
      time.options.clock(),
      ['fetch-reject', 'body-reject'].includes(failure) ? 24_000 : 25_000,
    )
    assert.ok(calls > 0)
    assert.ok(time.caps.every((cap) => cap <= 10_000))
    assert.equal(time.timers.size, 0)
    assert.ok(!JSON.stringify(time.logs).includes('private transport payload'))
    if (['fetch-stall', 'body-stall', 'abort'].includes(failure)) {
      assert.deepEqual(
        time.caps,
        [10_000, 10_000, 1_000].flatMap((cap) =>
          Array(checks.length).fill(cap),
        ),
      )
      assert.ok(signals.every((signal) => signal.aborted))
      assert.deepEqual(time.waits, [2_000, 2_000])
      assert.equal(time.logs.at(-1).path, '/__artifactshare_probe')
    }
    assert.ok(time.logs.every(({ status }) => status === 'transport-error'))
    assert.ok(signals.every((signal) => signal.aborted))
  })
}

for (const initialStage of ['refuse', 'usercontent']) {
  const stages =
    initialStage === 'refuse'
      ? ['app-refusal', 'sandbox-ready', 'final']
      : ['sandbox-ready', 'final']
  for (const [target, targetStage] of stages.entries()) {
    for (const persistent of [false, true]) {
      test(`${initialStage} gates write ${target + 1} with real polling (${persistent ? 'persistent' : 'transient'})`, async () => {
        const events = []
        let invocation = 0
        const result = deployContentCutover({
          readStage: () => initialStage,
          log: () => {},
          run: (args) => events.push(['write', args]),
          verify: async (stage) => {
            const current = invocation++
            assert.equal(stage, stages[current])
            const time = timing()
            const checks = expectedChecks(stage)
            let requests = 0
            await verifyContentCutover(
              stage,
              () => {
                const response = passingResponse(
                  checks[requests % checks.length],
                )
                if (
                  current === target &&
                  (persistent || requests < checks.length)
                )
                  response.status = 503
                requests++
                return response
              },
              time.options,
            )
            if (current === target) assert.deepEqual(time.waits, [2_000])
            events.push(['verified', stage])
          },
        })
        if (persistent)
          await assert.rejects(
            result,
            new RegExp(
              `Content cutover verification failed: ${targetStage}`,
              'u',
            ),
          )
        else await result
        assert.deepEqual(
          events.map(([event]) => event),
          persistent
            ? Array.from({ length: target * 2 + 1 }, (_, i) =>
                i % 2 ? 'verified' : 'write',
              )
            : stages.flatMap(() => ['write', 'verified']),
        )
      })
    }
  }
}

test('production defaults enforce a 75-second budget and two-second retry interval', async () => {
  const time = timing()
  delete time.options.timeoutMs
  let calls = 0
  await assert.rejects(
    verifyContentCutover(
      'app-refusal',
      () => {
        assert.ok(time.options.clock() < 75_000)
        calls++
        return new Response('private body', { status: 503 })
      },
      time.options,
    ),
    /Content cutover verification failed/u,
  )
  assert.equal(time.options.clock(), 74_000)
  assert.equal(calls, 38 * 5)
  assert.deepEqual(time.waits, Array(37).fill(2_000))
  assert.equal(time.caps[0], 10_000)
  assert.equal(time.caps.at(-1), 1_000)
})

test('a successful final body received at the deadline cannot pass', async () => {
  const checks = expectedChecks('sandbox-ready')
  const time = timing()
  let calls = 0
  await assert.rejects(
    verifyContentCutover(
      'sandbox-ready',
      () => {
        const response = passingResponse(checks[calls++])
        if (calls === checks.length)
          response.text = () => {
            time.advance(5_000)
            return Promise.resolve(probeMarker)
          }
        return response
      },
      time.options,
    ),
    (error) => {
      assert.ok(error.message.includes(new URL(checks.at(-1).url).hostname))
      return true
    },
  )
  assert.equal(calls, checks.length)
  assert.deepEqual(time.waits, [])
  assert.equal(time.logs.length, checks.length)
  assert.ok(time.logs.every(({ status }) => status === 'transport-error'))
})

test('late fetch completion aborts unread bodies even before the timer fires', async () => {
  const time = timing()
  let now = 0
  let signal
  let calls = 0
  let reads = 0
  const check = expectedChecks('app-refusal')[0]
  await assert.rejects(
    verifyContentCutover(
      'app-refusal',
      (_url, init) => {
        calls++
        signal = init.signal
        now = 5_000
        return {
          ...passingResponse(check),
          body: {
            getReader: () => ({
              read: () => {
                reads++
                return Promise.resolve({ done: true })
              },
              cancel: () => Promise.resolve(),
            }),
          },
        }
      },
      { ...time.options, clock: () => now },
    ),
    (error) => {
      assert.equal(
        error.message,
        `Content cutover verification failed: app-refusal ${new URL(check.url).hostname}/ (transport-error)`,
      )
      return true
    },
  )
  assert.equal(calls, 1)
  assert.equal(reads, 0)
  assert.ok(signal.aborted)
  assert.equal(time.timers.size, 0)
  assert.deepEqual(time.waits, [])
})

for (const stage of ['app-refusal', 'sandbox-ready', 'final']) {
  test(`${stage} starts all checks concurrently and logs failures as observed`, async () => {
    const time = timing(1_000)
    const checks = expectedChecks(stage)
    const pending = []
    const logged = checks.map(() => Promise.withResolvers())
    const verification = verifyContentCutover(
      stage,
      (url) => {
        const check = checks[pending.length]
        assert.equal(url, check.url)
        return new Promise((resolve) =>
          pending.push(() =>
            resolve({ ...passingResponse(check), status: 503 }),
          ),
        )
      },
      {
        ...time.options,
        log: (message, metadata) => {
          time.options.log(message, metadata)
          logged[time.logs.length - 1].resolve()
        },
      },
    )
    const rejected = assert.rejects(verification, (error) => {
      const last = new URL(checks.at(-1).url)
      assert.equal(
        error.message,
        `Content cutover verification failed: ${stage} ${last.hostname}${last.pathname} (503${checks.at(-1).deliveryStage ? `, ${checks.at(-1).deliveryStage}` : ''})`,
      )
      return true
    })
    assert.equal(pending.length, checks.length)
    // Resolve in reverse order; each log must appear before the others finish.
    for (let index = pending.length - 1; index >= 0; index--) {
      pending[index]()
      await logged[pending.length - index - 1].promise
      assert.equal(time.logs.at(-1).path, new URL(checks[index].url).pathname)
      assert.equal(
        time.logs.at(-1).hostname,
        new URL(checks[index].url).hostname,
      )
    }
    await rejected
    assert.equal(time.timers.size, 0)
  })

  for (const retry of [false, true]) {
    test(`${stage} accepts a fully passing attempt when the clock expires during collection (retry=${retry})`, async () => {
      const checks = expectedChecks(stage)
      const time = timing()
      let calls = 0
      await verifyContentCutover(
        stage,
        () => {
          const response = passingResponse(checks[calls++ % checks.length])
          if (retry && calls <= checks.length) response.status = 503
          return response
        },
        {
          ...time.options,
          clearTimer: (timer) => {
            time.options.clearTimer(timer)
            if (
              time.timers.size === 0 &&
              calls === checks.length * (retry ? 2 : 1)
            )
              time.advance(5_000)
          },
        },
      )
      assert.equal(calls, checks.length * (retry ? 2 : 1))
      assert.deepEqual(time.waits, retry ? [2_000] : [])
      assert.equal(time.logs.length, retry ? checks.length : 0)
    })
  }
}

test('exhaustion without an observed failure does not invent a failing check', async () => {
  const time = timing(0)
  let calls = 0
  await assert.rejects(
    verifyContentCutover(
      'app-refusal',
      () => {
        calls++
      },
      time.options,
    ),
    {
      message:
        'Content cutover verification failed: app-refusal deadline exhausted before a complete check set; no failing check observed',
    },
  )
  assert.equal(calls, 0)
  assert.deepEqual(time.logs, [])
  assert.deepEqual(time.waits, [])
})

for (const initialStage of ['refuse', 'usercontent']) {
  for (const expectedStage of initialStage === 'refuse'
    ? ['refuse', 'usercontent']
    : ['usercontent']) {
    for (const failure of [
      'stale',
      'malformed',
      'status',
      'fetch',
      'body',
      'stall',
    ]) {
      for (const persistent of [false, true]) {
        test(`${initialStage} confirms deployed ${expectedStage}: ${failure}, persistent=${persistent}`, async () => {
          const writes = []
          const confirmations = []
          const times = []
          const result = deployContentCutover({
            readStage: () => initialStage,
            log: () => {},
            run: (args) => writes.push(args),
            verify: async (stage, fetcher) => {
              const deliveryStage =
                stage === 'app-refusal' ? 'refuse' : 'usercontent'
              assert.equal(fetcher, undefined)
              const time = timing()
              times.push(time)
              const checks = expectedChecks(stage).filter(
                (check) => !check.deliveryStage,
              )
              let requests = 0
              let stageRequests = 0
              await verifyContentCutover(
                stage,
                (url, init) => {
                  assert.ok(time.options.clock() < 5_000)
                  if (url.endsWith('/__artifactshare_delivery_stage')) {
                    assert.equal(
                      url,
                      'https://artifactshare.com/__artifactshare_delivery_stage',
                    )
                    assert.equal(init.cache, 'no-store')
                    assert.equal(init.redirect, 'manual')
                    assert.ok(init.signal)
                    stageRequests++
                    confirmations.push(deliveryStage)
                    const fails =
                      deliveryStage === expectedStage &&
                      (persistent || stageRequests === 1)
                    if (fails && failure === 'fetch')
                      throw new Error('private transport payload')
                    return withBody({
                      status: fails && failure === 'status' ? 404 : 200,
                      text: () => {
                        if (fails && failure === 'body')
                          throw new Error('private body payload')
                        if (fails && failure === 'stall') {
                          time.advance(
                            Math.min(2_000, 5_000 - time.options.clock()),
                          )
                          return new Promise(() => {})
                        }
                        return Promise.resolve(
                          fails && failure === 'stale'
                            ? expectedStage === 'refuse'
                              ? 'usercontent'
                              : 'refuse'
                            : fails && failure === 'malformed'
                              ? 'private malformed payload'
                              : deliveryStage,
                        )
                      },
                    })
                  }
                  const check = checks[requests++ % checks.length]
                  assert.equal(url, check.url)
                  return passingResponse(check)
                },
                { ...time.options, requestTimeoutMs: 2_000 },
              )
              assert.equal(requests, checks.length * Math.max(1, stageRequests))
            },
          })
          const diagnostic = ['fetch', 'body', 'stall'].includes(failure)
            ? 'transport-error'
            : failure === 'status'
              ? `404, ${expectedStage}`
              : failure === 'malformed'
                ? '200, malformed'
                : `200, ${expectedStage === 'refuse' ? 'usercontent' : 'refuse'}`
          if (persistent) {
            await assert.rejects(result, (error) => {
              assert.match(
                error.message,
                /^Content cutover verification failed:/u,
              )
              assert.ok(
                error.message.includes(
                  'artifactshare.com/__artifactshare_delivery_stage',
                ),
              )
              assert.ok(!error.message.includes('private'))
              assert.ok(error.message.endsWith(`(${diagnostic})`))
              return true
            })
          } else {
            await result
          }
          assert.ok(confirmations.includes(expectedStage))
          assert.equal(
            writes.length,
            persistent && expectedStage === 'refuse'
              ? 1
              : initialStage === 'refuse'
                ? 3
                : 2,
          )
          assert.ok(
            !JSON.stringify(times.flatMap((time) => time.logs)).includes(
              'private',
            ),
          )
          assert.ok(times.every((time) => time.timers.size === 0))
          const failures = times
            .flatMap((time) => time.logs)
            .filter((entry) => entry.path === '/__artifactshare_delivery_stage')
          assert.ok(failures.length > 0)
          assert.ok(
            failures.every((entry) => entry.hostname === 'artifactshare.com'),
          )
          assert.equal(
            confirmations.filter((value) => value === expectedStage).length,
            persistent && failure !== 'stall' ? 3 : 2,
          )
          if (persistent)
            assert.equal(
              times.at(-1).options.clock(),
              failure === 'stall' ? 5_000 : 4_000,
            )
        })
      }
    }
  }
}

for (const confirmation of [false, true]) {
  test(`oversized ${confirmation ? 'delivery-stage' : 'probe'} streams are bounded and cancelled`, async () => {
    const time = timing()
    const checks = expectedChecks('sandbox-ready')
    const target = confirmation
      ? 'https://artifactshare.com/__artifactshare_delivery_stage'
      : checks.at(-1).url
    let reads = 0
    let cancellations = 0
    await assert.rejects(
      verifyContentCutover(
        confirmation ? 'final' : 'sandbox-ready',
        (url) => {
          if (url !== target)
            return passingResponse(checks.find((check) => check.url === url))
          let chunk = 0
          const response = new Response(
            new ReadableStream(
              {
                pull(controller) {
                  reads++
                  controller.enqueue(
                    new TextEncoder().encode(
                      chunk++ === 0
                        ? confirmation
                          ? 'usercontent'
                          : probeMarker
                        : 'x'.repeat(64),
                    ),
                  )
                },
                cancel() {
                  cancellations++
                  // Cancellation itself must never hold up a verification attempt.
                  return new Promise(() => {})
                },
              },
              { highWaterMark: 0 },
            ),
            {
              headers: confirmation
                ? {}
                : passingResponse(checks.at(-1)).headers,
            },
          )
          response.text = () => {
            throw new Error('Unbounded body read')
          }
          return response
        },
        time.options,
      ),
      (error) => {
        const url = new URL(target)
        assert.ok(error.message.includes(`${url.hostname}${url.pathname} (200`))
        if (confirmation) assert.match(error.message, /malformed/u)
        return true
      },
    )
    assert.equal(cancellations, 3)
    assert.equal(reads, 6)
    assert.equal(time.options.clock(), 4_000)
    assert.equal(time.timers.size, 0)
  })
}

test('fragmented exact probe bodies pass without waiting', async () => {
  const time = timing()
  const checks = expectedChecks('sandbox-ready')
  await verifyContentCutover(
    'sandbox-ready',
    (url) => {
      const check = checks.find((candidate) => candidate.url === url)
      if (!check.origin) return passingResponse(check)
      return new Response(
        new ReadableStream({
          start(controller) {
            for (const character of probeMarker)
              controller.enqueue(new TextEncoder().encode(character))
            controller.close()
          },
        }),
        { headers: passingResponse(check).headers },
      )
    },
    time.options,
  )
  assert.deepEqual(time.waits, [])
  assert.deepEqual(time.logs, [])
})

test('a stalled stream is cancelled at the deadline without waiting for cancellation', async () => {
  const time = timing(1_000)
  const checks = expectedChecks('sandbox-ready')
  let cancellations = 0
  await assert.rejects(
    verifyContentCutover(
      'sandbox-ready',
      (url) => {
        const check = checks.find((candidate) => candidate.url === url)
        if (url !== checks.at(-1).url) return passingResponse(check)
        return new Response(
          new ReadableStream(
            {
              pull() {
                queueMicrotask(() => time.advance(1_000))
                return new Promise(() => {})
              },
              cancel() {
                cancellations++
                return new Promise(() => {})
              },
            },
            { highWaterMark: 0 },
          ),
          { headers: passingResponse(check).headers },
        )
      },
      time.options,
    ),
    /transport-error/u,
  )
  assert.equal(cancellations, 1)
  assert.equal(time.options.clock(), 1_000)
  assert.equal(time.timers.size, 0)
  assert.deepEqual(time.waits, [])
})

for (const remainingMs of [500, 2_500]) {
  test(`preserves observed 503 without a futile retry when ${remainingMs}ms remain`, async () => {
    const time = timing()
    const checks = expectedChecks('sandbox-ready')
    let calls = 0
    await assert.rejects(
      verifyContentCutover(
        'sandbox-ready',
        () => {
          const response = passingResponse(checks[calls++ % checks.length])
          response.status = 503
          if (calls === checks.length) time.advance(5_000 - remainingMs)
          // A futile retry would lose the observed status at its short deadline.
          if (calls > checks.length) time.advance(1_000)
          return response
        },
        time.options,
      ),
      (error) => {
        const url = new URL(checks.at(-1).url)
        assert.equal(
          error.message,
          `Content cutover verification failed: sandbox-ready ${url.hostname}${url.pathname} (503)`,
        )
        return true
      },
    )
    assert.equal(calls, checks.length)
    assert.equal(time.options.clock(), 5_000 - remainingMs)
    assert.deepEqual(time.waits, [])
    assert.ok(time.logs.every(({ status }) => status === 503))
    assert.equal(time.timers.size, 0)
  })
}

test('rechecks the useful request budget after a delayed retry wait', async () => {
  const time = timing()
  const checks = expectedChecks('sandbox-ready')
  let calls = 0
  const waits = []
  await assert.rejects(
    verifyContentCutover(
      'sandbox-ready',
      () => {
        const response = passingResponse(checks[calls++ % checks.length])
        response.status = 503
        return response
      },
      {
        ...time.options,
        wait: (ms) => {
          waits.push(ms)
          time.advance(4_500)
        },
      },
    ),
    /\(503\)$/u,
  )
  assert.equal(calls, checks.length)
  assert.deepEqual(waits, [2_000])
})

test('final CLI uses the complete named check set without confirmation options', () => {
  const checks = expectedChecks('final')
  const preload = `
    const checks = ${JSON.stringify(checks)};
    let calls = 0;
    globalThis.fetch = async (url, init) => {
      const check = checks[calls++];
      if (!check || url !== check.url) throw new Error('Unexpected request');
      return new Response(check.deliveryStage ?? (check.origin ? ${JSON.stringify(probeMarker)} : 'Not found'), {
        status: check.status,
        headers: check.origin ? {
          'X-ArtifactShare-Sandbox-Probe': ${JSON.stringify(probeMarker)},
          'Cross-Origin-Resource-Policy': 'cross-origin',
          'Access-Control-Allow-Origin': check.origin,
        } : {},
      });
    };
    process.on('exit', () => { if (calls !== checks.length) process.exitCode = 1; });
  `
  const result = childProcess.spawnSync(
    process.execPath,
    [
      '--import',
      `data:text/javascript,${encodeURIComponent(preload)}`,
      'scripts/verify-content-cutover.mjs',
      'final',
    ],
    { encoding: 'utf8', timeout: 5_000 },
  )
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /Content cutover verified: final/u)
})

test('attempt admission respects the minimum budget and smaller request caps', async () => {
  const checks = expectedChecks('sandbox-ready')
  for (const [budget, requestCap, admitted] of [
    [999, 10_000, false],
    [1_000, 10_000, true],
    [499, 500, false],
    [500, 500, true],
  ]) {
    const time = timing(budget)
    let calls = 0
    const result = verifyContentCutover(
      'sandbox-ready',
      () => passingResponse(checks[calls++]),
      {
        ...time.options,
        requestTimeoutMs: requestCap,
      },
    )
    if (admitted) await result
    else await assert.rejects(result, /no failing check observed/u)
    assert.equal(calls, admitted ? checks.length : 0)
    assert.deepEqual(time.waits, [])
    assert.equal(time.timers.size, 0)
  }
})
