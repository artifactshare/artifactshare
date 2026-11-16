import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from 'node:fs'
import { connect, createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  createRuntimeRoot,
  localCaptureCommands,
  localTopology,
  OwnedProcesses,
  ownedEnvironment,
  portIsFree,
  runLocalCapture,
  selectPorts,
  startLoopbackRelay,
  waitUntilReady,
} from './local-capture.mjs'

const PORTS = {
  app: 41101,
  sandbox: 41102,
  ogImage: 41103,
  appInspector: 41104,
  sandboxInspector: 41105,
  ogImageInspector: 41106,
}

function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'local-capture-test-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

function listening(host) {
  return new Promise((done, fail) => {
    const server = createServer()
    server.once('error', fail)
    server.listen({ port: 0, host }, () => done(server))
  })
}

function alive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error.code !== 'ESRCH'
  }
}

async function until(condition, what, ms = 10_000) {
  const deadline = Date.now() + ms
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await new Promise((done) => setTimeout(done, 50))
  }
}

const node = (name, source, extra = {}) => ({
  name,
  command: process.execPath,
  args: ['-e', source],
  cwd: process.cwd(),
  env: process.env,
  ...extra,
})

// A plan of real Node processes standing in for setup, services and capture.
function fakeRun(t, plan, overrides = {}) {
  const base = tempDir(t)
  const lines = []
  let runtime
  const signals = new EventEmitter()
  const result = runLocalCapture({
    mode: 'screens',
    argv: ['--screen', 'about'],
    env: { ...process.env },
    signals,
    log: (line) => lines.push(line),
    deps: {
      head: () => 'a'.repeat(40),
      select: () => Promise.resolve(PORTS),
      runtimeRoot: () => (runtime = createRuntimeRoot({ tmp: base })),
      commands: () => plan,
      owner: new OwnedProcesses({ graceMs: 300, killWaitMs: 2_000 }),
      relay: () => Promise.resolve({ close: () => Promise.resolve() }),
      checks: () => [],
      readyTimeoutMs: 5_000,
      ...overrides,
    },
  })
  return { result, lines, signals, base, runtime: () => runtime }
}

test('automatic ports avoid the pnpm dev ports, occupied ports and each other', async () => {
  const offered = [
    5173, 41001, 41001, 41002, 5175, 41003, 41004, 41005, 41006, 41007,
  ]
  const ports = await selectPorts({
    env: {},
    nextPort: () => offered.shift(),
    isFree: (port) => port !== 41002,
  })
  assert.deepEqual(ports, {
    app: 41001,
    sandbox: 41003,
    ogImage: 41004,
    appInspector: 41005,
    sandboxInspector: 41006,
    ogImageInspector: 41007,
  })
})

test('a port held on only one loopback family is not free', async () => {
  for (const host of ['127.0.0.1', '::1']) {
    const server = await listening(host)
    const { port } = server.address()
    assert.equal(await portIsFree(port), false, `held on ${host}`)
    await new Promise((done) => server.close(done))
    assert.equal(await portIsFree(port), true, `released on ${host}`)
  }
})

test('explicit ports must be valid, distinct and free', async () => {
  const free = () => true
  for (const value of ['abc', '0', '70000', '80.5'])
    await assert.rejects(
      selectPorts({ env: { LOCAL_CAPTURE_APP_PORT: value }, isFree: free }),
      /LOCAL_CAPTURE_APP_PORT must be a TCP port/,
    )
  await assert.rejects(
    selectPorts({
      env: {
        LOCAL_CAPTURE_APP_PORT: '41201',
        LOCAL_CAPTURE_SANDBOX_PORT: '41201',
      },
      isFree: free,
    }),
    /LOCAL_CAPTURE_SANDBOX_PORT and LOCAL_CAPTURE_APP_PORT both select port 41201/,
  )
  await assert.rejects(
    selectPorts({
      env: { LOCAL_CAPTURE_OG_IMAGE_PORT: '41202' },
      isFree: (port) => port !== 41202,
    }),
    /LOCAL_CAPTURE_OG_IMAGE_PORT=41202 is already in use/,
  )
  const offered = [41301, 41302, 41303, 41304, 41305]
  const ports = await selectPorts({
    env: { LOCAL_CAPTURE_APP_PORT: '41300' },
    isFree: free,
    nextPort: () => offered.shift(),
  })
  assert.equal(ports.app, 41300)
  assert.equal(ports.sandbox, 41301)
})

test('every child gets this invocation registry, storage, logs and ports, never inherited ones', (t) => {
  const runtime = createRuntimeRoot({ tmp: tempDir(t) })
  const env = ownedEnvironment(
    {
      PATH: process.env.PATH,
      SCREEN_CAPTURE_BASE_URL: 'https://localhost:5173',
      SCREEN_CAPTURE_SANDBOX_URL: 'https://localhost:5174',
      CLOUDFLARE_DEV_REGISTRY_PATH: '/default/registry',
      WRANGLER_REGISTRY_PATH: '/default/wrangler-registry',
      WRANGLER_LOG_PATH: '../../.wrangler/logs',
      ARTIFACTSHARE_DEV_PERSIST_PATH: '/developer/state',
      ARTIFACTSHARE_DEV_APP_PORT: '5173',
    },
    runtime,
  )
  for (const mode of ['screens', 'walkthroughs']) {
    const plan = localCaptureCommands({
      mode,
      argv:
        mode === 'screens'
          ? ['--screen', 'about']
          : ['--task', 'share-file-link'],
      ports: PORTS,
      runtime,
      env,
      root: '/repo',
      cliBuilt: false,
    })
    const children = [...plan.setup, ...plan.services, plan.capture]
    for (const child of children) {
      assert.equal(
        child.env.CLOUDFLARE_DEV_REGISTRY_PATH,
        runtime.registry,
        child.name,
      )
      assert.equal(
        child.env.WRANGLER_REGISTRY_PATH,
        runtime.registry,
        child.name,
      )
      assert.equal(child.env.WRANGLER_LOG_PATH, runtime.logs, child.name)
      assert.equal(
        child.env.ARTIFACTSHARE_DEV_PERSIST_PATH,
        runtime.persist,
        child.name,
      )
    }
    const prepare = plan.setup.find((child) => child.name === 'prepare')
    assert.deepEqual(JSON.parse(prepare.env.LOCAL_CAPTURE_PREPARE), {
      persistTo: runtime.persist,
    })
    assert.equal(
      plan.setup.some((child) => child.name === 'cli build'),
      mode === 'walkthroughs',
    )
    const byName = Object.fromEntries(
      plan.services.map((child) => [child.name, child]),
    )
    const flag = (child, name) => child.args[child.args.indexOf(name) + 1]
    for (const [name, port, inspector] of [
      ['og-image', PORTS.ogImage, PORTS.ogImageInspector],
      ['sandbox', PORTS.sandbox, PORTS.sandboxInspector],
    ]) {
      assert.equal(flag(byName[name], '--port'), String(port))
      assert.equal(flag(byName[name], '--inspector-port'), String(inspector))
      assert.equal(flag(byName[name], '--persist-to'), runtime.persist)
    }
    const vars = byName.sandbox.args.filter(
      (_, index) => byName.sandbox.args[index - 1] === '--var',
    )
    assert.deepEqual(vars, [
      'DEV_APP_PORT:41101',
      'DEV_SANDBOX_PORT:41102',
      'BETTER_AUTH_URL:https://localhost:41101',
    ])
    assert.equal(byName.app.env.ARTIFACTSHARE_DEV_APP_PORT, '41101')
    assert.equal(byName.app.env.ARTIFACTSHARE_DEV_SANDBOX_PORT, '41102')
    assert.equal(byName.app.env.ARTIFACTSHARE_DEV_INSPECTOR_PORT, '41104')
    assert.equal(byName.app.env.ARTIFACTSHARE_DEV_HOST, '::1')
    assert.equal(
      plan.capture.env.SCREEN_CAPTURE_BASE_URL,
      'https://localhost:41101',
    )
    assert.equal(
      plan.capture.env.SCREEN_CAPTURE_SANDBOX_URL,
      'https://localhost:41102',
    )
    assert.deepEqual(
      plan.capture.args.slice(1),
      mode === 'screens'
        ? ['--screen', 'about']
        : ['--task', 'share-file-link'],
    )
  }
  assert.deepEqual(localTopology(PORTS), {
    appOrigin: 'https://localhost:41101',
    sandboxOrigin: 'https://localhost:41102',
    ogImageOrigin: 'https://localhost:41103',
  })
})

test('the runtime root is removed when it would overlap a checkout', (t) => {
  const base = tempDir(t)
  assert.throws(
    () =>
      createRuntimeRoot({
        tmp: base,
        assertOutside: () => {
          throw new Error('Capture output overlaps a registered worktree')
        },
      }),
    /overlaps a registered worktree/,
  )
  assert.deepEqual(readdirSync(base), [])
})

test('the IPv4 relay reaches an IPv6-only server and refuses a taken port', async () => {
  const server = createServer((socket) => socket.end('from ipv6'))
  await new Promise((done) => server.listen({ port: 0, host: '::1' }, done))
  const { port } = server.address()
  const relay = await startLoopbackRelay(port)
  const reply = await new Promise((done, fail) => {
    let text = ''
    connect({ port, host: '127.0.0.1' })
      .on('data', (chunk) => (text += chunk))
      .on('end', () => done(text))
      .on('error', fail)
  })
  assert.equal(reply, 'from ipv6')
  await assert.rejects(
    startLoopbackRelay(port),
    /was taken after it was selected/,
  )
  await relay.close()
  await new Promise((done) => server.close(done))
})

test('readiness fails at its deadline with each pending check', async () => {
  await assert.rejects(
    waitUntilReady({
      checks: [
        { name: 'app on ::1', check: () => {} },
        {
          name: 'og-image service binding',
          check: () => {
            throw new Error('/og-image answered HTTP 500')
          },
        },
      ],
      timeoutMs: 50,
      intervalMs: 1,
    }),
    (error) =>
      /not ready within/.test(error.message) &&
      /og-image service binding: \/og-image answered HTTP 500/.test(
        error.message,
      ) &&
      !/app on ::1/.test(error.message),
  )
})

test('the readiness deadline aborts a stalled check and rejects a late pass', async () => {
  let stalledSignal
  const started = Date.now()
  await assert.rejects(
    waitUntilReady({
      checks: [
        {
          name: 'app on 127.0.0.1',
          // Never settles by itself, like a response that keeps streaming.
          check: (signal) => {
            stalledSignal = signal
            return new Promise(() => {})
          },
        },
      ],
      timeoutMs: 50,
    }),
    /app on 127\.0\.0\.1: no answer before the deadline/,
  )
  assert.ok(Date.now() - started < 1_000, 'the deadline did not bound the wait')
  assert.equal(stalledSignal.aborted, true)

  const late = (ms) => () => new Promise((done) => setTimeout(done, ms))
  await assert.rejects(
    waitUntilReady({
      checks: [{ name: 'sandbox on ::1', check: late(80) }],
      timeoutMs: 5,
    }),
    /sandbox on ::1: no answer before the deadline/,
  )
  await waitUntilReady({
    checks: [{ name: 'sandbox on ::1', check: late(5) }],
    timeoutMs: 1_000,
  })
})

test('an invalid selection fails before any input or service is prepared', async () => {
  const calls = []
  const status = await runLocalCapture({
    mode: 'screens',
    argv: ['--screen', 'no-such-screen'],
    signals: new EventEmitter(),
    log: (line) => calls.push(line),
    deps: {
      head: () => calls.push('head'),
      runtimeRoot: () => calls.push('runtime'),
      select: () => calls.push('ports'),
    },
  })
  assert.equal(status, 1)
  assert.match(calls.join('\n'), /Unknown screen id: no-such-screen/)
  assert.ok(!calls.includes('runtime') && !calls.includes('ports'))
})

test('a successful capture exits zero after stopping services and removing the runtime root', async (t) => {
  const dir = tempDir(t)
  const pidFile = join(dir, 'service.pid')
  const run = fakeRun(t, {
    setup: [node('prepare', '')],
    services: [
      node(
        'app',
        `require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000)`,
      ),
    ],
    // The fake readiness has no checks, so the capture waits for the service.
    capture: node(
      'capture',
      `const t = setInterval(() => require('fs').existsSync(${JSON.stringify(pidFile)}) && clearInterval(t), 20)`,
    ),
  })
  assert.equal(await run.result, 0)
  assert.equal(alive(Number(readFileSync(pidFile, 'utf8'))), false)
  assert.equal(existsSync(run.runtime().root), false)
})

test('capture, setup, readiness and service failures exit nonzero without capturing elsewhere', async (t) => {
  const dir = tempDir(t)
  const captured = join(dir, 'captured')
  const capture = node(
    'capture',
    `require('fs').writeFileSync(${JSON.stringify(captured)}, '')`,
  )
  const idle = node('app', 'setInterval(() => {}, 1000)')

  const failedCapture = fakeRun(t, {
    setup: [],
    services: [idle],
    capture: node('capture', 'process.exit(3)'),
  })
  assert.equal(await failedCapture.result, 1)
  assert.match(failedCapture.lines.join('\n'), /capture failed \(exit code 3\)/)

  const failedSetup = fakeRun(t, {
    setup: [node('prepare', 'process.exit(2)')],
    services: [idle],
    capture,
  })
  assert.equal(await failedSetup.result, 1)
  assert.match(failedSetup.lines.join('\n'), /prepare failed \(exit code 2\)/)

  const neverReady = fakeRun(
    t,
    { setup: [], services: [idle], capture },
    {
      readyTimeoutMs: 50,
      checks: () => [
        {
          name: 'sandbox on 127.0.0.1',
          check: () => {
            throw new Error('connect ECONNREFUSED')
          },
        },
      ],
    },
  )
  assert.equal(await neverReady.result, 1)
  assert.match(
    neverReady.lines.join('\n'),
    /sandbox on 127.0.0.1: connect ECONNREFUSED/,
  )

  const serviceDied = fakeRun(
    t,
    { setup: [], services: [node('og-image', 'process.exit(4)')], capture },
    {
      checks: () => [
        {
          name: 'og-image on ::1',
          check: () => {
            throw new Error('not yet')
          },
        },
      ],
    },
  )
  assert.equal(await serviceDied.result, 1)
  assert.match(
    serviceDied.lines.join('\n'),
    /og-image dev server exited \(code 4\)/,
  )

  assert.equal(existsSync(captured), false)
})

// The capture ignores SIGTERM and leaves a SIGTERM-ignoring grandchild in a
// session of its own, so only the descendant walk and SIGKILL can stop them.
const STUBBORN = (dir) => `
  const { spawn } = require('child_process')
  const fs = require('fs')
  process.on('SIGTERM', () => {})
  const grandchild = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { detached: true, stdio: 'ignore' })
  fs.writeFileSync(${JSON.stringify(join(dir, 'pids'))}, JSON.stringify([process.pid, grandchild.pid]))
  setInterval(() => {}, 1000)
`

test('a detached grandchild is stopped after the child that started it has exited', async (t) => {
  const dir = tempDir(t)
  const ack = join(dir, 'grandchild.pid')
  // The grandchild leaves the capture's session and acknowledges; only then
  // does the capture exit, so the grandchild is reparented before teardown.
  const grandchildSource = `process.on('SIGTERM', () => {}); require('fs').writeFileSync(${JSON.stringify(ack)}, String(process.pid)); setInterval(() => {}, 1000)`
  const run = fakeRun(t, {
    setup: [],
    services: [node('app', 'setInterval(() => {}, 1000)')],
    capture: node(
      'capture',
      `
      const { spawn } = require('child_process')
      const fs = require('fs')
      spawn(process.execPath, ['-e', ${JSON.stringify(grandchildSource)}], { detached: true, stdio: 'ignore' }).unref()
      const wait = setInterval(() => fs.existsSync(${JSON.stringify(ack)}) && clearInterval(wait), 20)
      `,
    ),
  })
  assert.equal(await run.result, 0, run.lines.join('\n'))
  const grandchild = Number(readFileSync(ack, 'utf8'))
  assert.equal(alive(grandchild), false, `grandchild ${grandchild} survived`)
})

for (const [phase, signal, status] of [
  ['setup', 'SIGINT', 130],
  ['capture', 'SIGTERM', 143],
]) {
  test(`${signal} during ${phase} stops every owned descendant, then exits ${status}`, async (t) => {
    const dir = tempDir(t)
    const service = join(dir, 'service-started')
    const stubborn = node(phase, STUBBORN(dir))
    const run = fakeRun(t, {
      setup: phase === 'setup' ? [stubborn] : [],
      services: [
        node(
          'app',
          `require('fs').writeFileSync(${JSON.stringify(service)}, ''); setInterval(() => {}, 1000)`,
        ),
      ],
      capture: phase === 'capture' ? stubborn : node('capture', ''),
    })
    await until(() => existsSync(join(dir, 'pids')), `${phase} to start`)
    const pids = JSON.parse(readFileSync(join(dir, 'pids'), 'utf8'))
    run.signals.emit(signal)
    run.signals.emit(signal)
    assert.equal(await run.result, status)
    for (const pid of pids)
      assert.equal(alive(pid), false, `pid ${pid} survived`)
    assert.equal(existsSync(run.runtime().root), false)
    assert.equal(existsSync(service), phase === 'capture')
    assert.match(
      run.lines.join('\n'),
      new RegExp(`${signal} received again; still stopping`),
    )
  })
}
