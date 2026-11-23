import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { connect, createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { parseDevPort } from '../apps/web/app/lib/hosts.ts'
import {
  AUTOMATIC_PORT_RANGE,
  automaticPort,
  checkoutStoreDir,
  createRuntimeRoot,
  DEFAULT_DEV_PORTS,
  exportSource,
  localCaptureCommands,
  localInputs,
  localTopology,
  OwnedProcesses,
  ownedEnvironment,
  portIsFree,
  runLocalCapture,
  runPrepareStep,
  selectPorts,
  startLoopbackRelay,
  waitUntilReady,
  writeCaptureStripeVars,
} from './local-capture.mjs'
import {
  CAPTURE_STRIPE_PRICES,
  CAPTURE_STRIPE_SECRET_KEY,
  captureStripeVars,
  startCaptureStripe,
} from './capture-stripe.mjs'

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
      inputs: (root) => {
        writeFileSync(root.vars, 'BETTER_AUTH_SECRET=kept\n')
        return { certs: { dir: root.certs }, vars: { path: root.vars } }
      },
      storeDir: () => '/store',
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

test('automatic ports stay below the Linux, macOS and Windows ephemeral ranges', () => {
  assert.equal(
    automaticPort(() => 0),
    AUTOMATIC_PORT_RANGE.first,
  )
  assert.equal(
    automaticPort(() => 0.999_999_999),
    AUTOMATIC_PORT_RANGE.last,
  )
  assert.ok(AUTOMATIC_PORT_RANGE.first > Math.max(...DEFAULT_DEV_PORTS))
  assert.ok(AUTOMATIC_PORT_RANGE.last < 32768)
})

test('selectPorts takes automatic ports from the automatic range by default', async () => {
  const ports = await selectPorts({ env: {}, isFree: () => true })
  for (const [name, port] of Object.entries(ports))
    assert.ok(
      port >= AUTOMATIC_PORT_RANGE.first && port <= AUTOMATIC_PORT_RANGE.last,
      `${name}=${port}`,
    )
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
  for (const value of ['abc', '0', '70000', '80.5', '443', '1023'])
    await assert.rejects(
      selectPorts({ env: { LOCAL_CAPTURE_APP_PORT: value }, isFree: free }),
      /LOCAL_CAPTURE_APP_PORT must be a TCP port from 1024 to 65535/,
    )
  await assert.rejects(
    selectPorts({ env: { LOCAL_CAPTURE_SANDBOX_PORT: '443' }, isFree: free }),
    /LOCAL_CAPTURE_SANDBOX_PORT must be a TCP port from 1024 to 65535, got 443/,
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

test('the port rule matches the one the Workers and Vite config apply', () => {
  const examples = [
    '1024',
    '5173',
    '65535',
    '443',
    '1023',
    '0',
    '65536',
    'abc',
    '80.5',
    ' 5173',
    '',
  ]
  const outcome = (parse) => (value) => {
    try {
      return parse('PORT', value) ?? 'default'
    } catch {
      return 'rejected'
    }
  }
  assert.deepEqual(examples.map(outcome(parseDevPort)), [
    1024,
    5173,
    65535,
    'rejected',
    'rejected',
    'rejected',
    'rejected',
    'rejected',
    'rejected',
    'rejected',
    'default',
  ])
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
      ARTIFACTSHARE_DEV_VITE_CACHE_DIR: '/developer/vite-cache',
      MINIFLARE_CACHE_DIR: '/developer/mf-cache',
      WRANGLER_CACHE_DIR: '/developer/wrangler-cache',
      CLOUDFLARE_CF_FETCH_PATH: '/developer/cf.json',
      WALKTHROUGH_CLI_ENTRY: '/developer/cli/dist/index.js',
      GIT_DIR: '/repo/.git',
    },
    runtime,
  )
  assert.equal(env.CLOUDFLARE_CF_FETCH_PATH, undefined)
  const inputs = {
    certs: { dir: runtime.certs, generate: true },
    vars: { path: runtime.vars, copiedFrom: '/repo/.dev.vars' },
  }
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
      inputs,
      revision: 'a'.repeat(40),
      storeDir: '/store/v11',
      root: '/repo',
    })
    const children = [...plan.setup, ...plan.services, plan.capture]
    // Only the capture runs from the checkout; every setup step after the
    // export and every service runs from the export of HEAD.
    for (const child of [...plan.setup.slice(1), ...plan.services])
      assert.ok(child.cwd.startsWith(runtime.source), child.name)
    // The export gets its own install, offline from the checkout's store,
    // without the Git variables that could lead a script to the checkout.
    const install = plan.setup.find(
      (child) => child.name === 'dependency install',
    )
    assert.equal(install.command, 'pnpm')
    assert.deepEqual(install.args, [
      'install',
      '--frozen-lockfile',
      '--offline',
      '--store-dir',
      '/store/v11',
    ])
    assert.equal(install.cwd, runtime.source)
    assert.equal(install.env.GIT_DIR, undefined)
    assert.equal(install.env.GIT_CEILING_DIRECTORIES, runtime.root)
    for (const child of children) {
      // Inherited cache locations are dropped: the services' caches stay in
      // the export's own node_modules.
      assert.equal(child.env.MINIFLARE_CACHE_DIR, undefined, child.name)
      assert.equal(child.env.WRANGLER_CACHE_DIR, undefined, child.name)
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
      certs: runtime.certs,
      vars: runtime.vars,
    })
    // No setup step writes a shared build output (contract or CLI dist).
    assert.deepEqual(
      plan.setup.map((child) => child.name),
      mode === 'walkthroughs'
        ? ['source export', 'dependency install', 'prepare', 'cli build']
        : ['source export', 'dependency install', 'prepare'],
    )
    assert.deepEqual(plan.setup[0].args.slice(1), [
      'export-source',
      runtime.source,
      'a'.repeat(40),
    ])
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
      assert.equal(flag(byName[name], '--env-file'), runtime.vars)
      assert.equal(
        flag(byName[name], '--https-cert-path'),
        join(runtime.certs, 'cert.pem'),
      )
    }
    assert.equal(byName.app.env.ARTIFACTSHARE_DEV_GIT_ROOT, '/repo')
    assert.equal(byName.app.env.ARTIFACTSHARE_DEV_CERT_DIR, runtime.certs)
    assert.equal(byName.app.env.ARTIFACTSHARE_DEV_VARS_PATH, runtime.vars)
    assert.equal(byName.app.env.ARTIFACTSHARE_DEV_VITE_CACHE_DIR, undefined)
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
    assert.equal(
      plan.capture.env.WALKTHROUGH_CLI_ENTRY,
      mode === 'walkthroughs'
        ? join(runtime.source, 'packages/cli/dist/index.js')
        : undefined,
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

test('a usable checkout certificate is used read-only, a missing or obsolete one goes to the runtime directory, and variables are always a runtime copy', (t) => {
  const runtimeRoot = () => createRuntimeRoot({ tmp: tempDir(t) })
  const checkout = (files) => {
    const root = tempDir(t)
    for (const [file, content] of Object.entries(files)) {
      mkdirSync(dirname(join(root, file)), { recursive: true })
      writeFileSync(join(root, file), content)
    }
    return root
  }
  const valid = (pem) => String(pem) === 'valid'
  const usable = checkout({
    '.dev-certs/cert.pem': 'valid',
    '.dev-certs/key.pem': 'key',
    '.dev.vars': 'BETTER_AUTH_SECRET=kept\n',
  })
  const runtime = runtimeRoot()
  assert.deepEqual(
    localInputs({ root: usable, runtime, certificateValid: valid }),
    {
      certs: { dir: join(usable, '.dev-certs'), generate: false },
      vars: { path: runtime.vars, copiedFrom: join(usable, '.dev.vars') },
    },
  )
  assert.equal(readFileSync(runtime.vars, 'utf8'), 'BETTER_AUTH_SECRET=kept\n')
  for (const files of [
    { '.dev-certs/cert.pem': 'obsolete', '.dev-certs/key.pem': 'key' },
    { '.dev-certs/cert.pem': 'valid' },
    {},
  ]) {
    const root = checkout(files)
    const fresh = runtimeRoot()
    assert.deepEqual(
      localInputs({ root, runtime: fresh, certificateValid: valid }),
      {
        certs: { dir: fresh.certs, generate: true },
        // Prepare creates the variables in the runtime directory; the
        // checkout path is never handed to it.
        vars: { path: fresh.vars, copiedFrom: null },
      },
      JSON.stringify(files),
    )
    assert.equal(existsSync(join(root, '.dev.vars')), false)
  }
})

test('the services read only the fake Stripe values, from copied variables, the template or the environment', (t) => {
  const developerKey = ['sk', 'test', 'developer'].join('_')
  const copied = [
    'BETTER_AUTH_SECRET=kept',
    `STRIPE_SECRET_KEY=${developerKey}`,
    'STRIPE_PRICE_TEAM_MONTHLY=price_developer_team',
    'export STRIPE_PRICE_PLUS_MONTHLY=price_developer_plus',
    'STRIPE_WEBHOOK_SECRET=developer-webhook-secret',
    'STRIPE_API_ORIGIN=https://api.stripe.com',
    `STRIPE_SECRET_KEY=${developerKey}`,
    // Colon and multi-line quoted forms Wrangler's dotenv parser accepts.
    'STRIPE_WEBHOOK_SECRET: developer-colon-secret',
    'STRIPE_PRICE_TEAM_YEARLY="price_developer',
    'team_yearly" # developer copy',
    'DEV_FLAGS=bot-members',
  ].join('\n')
  const template = readFileSync(
    join(import.meta.dirname, '../.dev.vars.example'),
    'utf8',
  )
  const origin = 'http://127.0.0.1:4242'
  for (const [source, content] of [
    ['copied', copied],
    ['template', template],
  ]) {
    const runtime = createRuntimeRoot({ tmp: tempDir(t) })
    writeFileSync(runtime.vars, content)
    writeCaptureStripeVars(runtime.vars, origin)
    const lines = readFileSync(runtime.vars, 'utf8').split('\n')
    const stripe = lines
      .filter((line) => /^\s*(?:export\s+)?STRIPE_/u.test(line))
      .map((line) => line.split('='))
    // Each Stripe variable appears once, with the fake's value, whichever
    // copy a parser would keep.
    assert.equal(
      stripe.length,
      Object.keys(captureStripeVars(origin)).length,
      source,
    )
    assert.deepEqual(
      Object.fromEntries(stripe),
      captureStripeVars(origin),
      source,
    )
    assert.ok(!lines.some((line) => line.includes('developer')), source)
    assert.ok(lines.includes('DEV_FLAGS=bot-members'), source)
    if (source === 'copied')
      assert.ok(lines.includes('BETTER_AUTH_SECRET=kept'))
  }
  // Inherited Stripe settings never reach a child either.
  const runtime = createRuntimeRoot({ tmp: tempDir(t) })
  const plan = localCaptureCommands({
    mode: 'screens',
    argv: ['--screen', 'settings-billing'],
    ports: PORTS,
    runtime,
    env: ownedEnvironment(
      {
        PATH: process.env.PATH,
        STRIPE_SECRET_KEY: developerKey,
        STRIPE_API_ORIGIN: 'https://api.stripe.com',
        // Production mode would turn the override and dev sign-in off.
        NODE_ENV: 'production',
      },
      runtime,
    ),
    inputs: {
      certs: { dir: runtime.certs, generate: true },
      vars: { path: runtime.vars, copiedFrom: null },
    },
    revision: 'a'.repeat(40),
    storeDir: '/store',
    root: '/repo',
  })
  for (const child of [...plan.setup, ...plan.services, plan.capture])
    assert.deepEqual(
      Object.keys(child.env).filter((name) => name.startsWith('STRIPE_')),
      [],
      child.name,
    )
  const app = plan.services.find((child) => child.name === 'app')
  assert.equal(app.env.NODE_ENV, 'development')
})

test('the fake Stripe answers only fixture reads and previews on loopback, until it is closed', async () => {
  const fake = await startCaptureStripe({
    now: new Date('2026-11-24T10:00:00.000Z'),
  })
  assert.equal(new URL(fake.origin).hostname, '127.0.0.1')
  const call = async (method, path, { body, key } = {}) => {
    const response = await fetch(`${fake.origin}${path}`, {
      method,
      body,
      headers: {
        authorization: `Bearer ${key ?? CAPTURE_STRIPE_SECRET_KEY}`,
        ...(body
          ? { 'content-type': 'application/x-www-form-urlencoded' }
          : {}),
      },
    })
    return { status: response.status, body: await response.json() }
  }
  const id = 'sub_capture_dev-screen-free-settings-billing-past-due'
  const preview = (price) =>
    new URLSearchParams({
      subscription: id,
      'subscription_details[items][0][id]':
        'si_capture_dev-screen-free-settings-billing-past-due',
      'subscription_details[items][0][price]': price,
      'subscription_details[proration_behavior]': 'always_invoice',
      'subscription_details[proration_date]': '1800000000',
    }).toString()
  try {
    const subscription = await call(
      'GET',
      `/v1/subscriptions/${id}?expand[0]=items.data.price`,
    )
    assert.equal(subscription.status, 200)
    assert.deepEqual(
      {
        status: subscription.body.status,
        workspace: subscription.body.metadata.workspace_id,
        price: subscription.body.items.data[0].price.id,
        period: [
          subscription.body.items.data[0].current_period_start,
          subscription.body.items.data[0].current_period_end,
        ],
      },
      {
        status: 'past_due',
        workspace: 'dev-screen-free-settings-billing-past-due',
        price: CAPTURE_STRIPE_PRICES.teamMonthly,
        // The monthly period containing the instance's start time.
        period: [Date.UTC(2026, 10, 1) / 1000, Date.UTC(2026, 11, 1) / 1000],
      },
    )
    const change = await call('POST', '/v1/invoices/create_preview', {
      body: preview(CAPTURE_STRIPE_PRICES.plusMonthly),
    })
    assert.equal(change.status, 200)
    assert.deepEqual(change.body.lines.data[0].period.start, 1800000000)
    for (const [method, path, options] of [
      ['GET', '/v1/subscriptions/sub_1Developer'],
      // A malformed escape is refused, not thrown inside the server.
      ['GET', '/v1/subscriptions/sub_capture_%E0%A4%A'],
      ['GET', '/v1/subscriptions/sub_capture_dev-screen-team-home-empty'],
      ['GET', `/v1/subscriptions/${id}`, { key: 'not-the-capture-key' }],
      ['POST', `/v1/subscriptions/${id}`, { body: 'items[0][price]=x' }],
      ['POST', '/v1/customers', { body: 'metadata[workspace_id]=x' }],
      ['POST', '/v1/checkout/sessions', { body: 'mode=subscription' }],
      [
        'POST',
        '/v1/invoices/create_preview',
        { body: preview(CAPTURE_STRIPE_PRICES.teamMonthly) },
      ],
    ]) {
      const refused = await call(method, path, options)
      assert.ok(refused.status >= 400, `${method} ${path}`)
      assert.ok(refused.body.error, `${method} ${path}`)
    }
    // Still serving after every refusal.
    assert.equal((await call('GET', `/v1/subscriptions/${id}`)).status, 200)
  } finally {
    await fake.close()
  }
  await assert.rejects(fetch(`${fake.origin}/v1/subscriptions/${id}`))
})

test('a walkthrough builds the CLI for HEAD into the runtime directory, even beside a stale dist', (t) => {
  const root = tempDir(t)
  mkdirSync(join(root, 'packages/cli/dist'), { recursive: true })
  writeFileSync(join(root, 'packages/cli/dist/index.js'), '// earlier HEAD')
  const runtime = createRuntimeRoot({ tmp: tempDir(t) })
  const plan = localCaptureCommands({
    mode: 'walkthroughs',
    argv: ['--task', 'share-file-link'],
    ports: PORTS,
    runtime,
    env: ownedEnvironment({}, runtime),
    inputs: {
      certs: { dir: runtime.certs, generate: true },
      vars: { path: runtime.vars, copiedFrom: null },
    },
    revision: 'a'.repeat(40),
    storeDir: '/store/v11',
    root,
  })
  const build = plan.setup.find((child) => child.name === 'cli build')
  assert.ok(build, 'no CLI build planned')
  // The package's own build, run in the export.
  assert.equal(build.command, 'pnpm')
  assert.deepEqual(build.args, ['--filter', '@artifactshare/cli', 'build'])
  assert.equal(build.cwd, runtime.source)
  assert.equal(
    plan.capture.env.WALKTHROUGH_CLI_ENTRY,
    join(runtime.source, 'packages/cli/dist/index.js'),
  )
})

test('the export holds HEAD only; its dependencies come from its own install', (t) => {
  const root = realpathSync(tempDir(t))
  const write = (file, content) => {
    mkdirSync(dirname(join(root, file)), { recursive: true })
    writeFileSync(join(root, file), content)
  }
  const git = (...args) =>
    execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()
  write('package.json', '{}')
  write('apps/web/package.json', '{}')
  git('init', '--quiet')
  git('add', '-A')
  git(
    '-c',
    'user.name=t',
    '-c',
    'user.email=t@example.com',
    'commit',
    '-qm',
    'head',
  )
  const head = git('rev-parse', 'HEAD')
  write('apps/web/uncommitted.txt', 'not in HEAD')
  // An installed checkout: nothing of it may reach the export.
  write('node_modules/dep/index.js', '')
  write('apps/web/node_modules/dep/index.js', '')
  write(
    'node_modules/.modules.yaml',
    JSON.stringify({ storeDir: '/store/v11', nodeLinker: 'isolated' }),
  )
  const dest = join(realpathSync(tempDir(t)), 'source')
  exportSource({ root, dest, revision: head })

  assert.ok(existsSync(join(dest, 'apps/web/package.json')))
  assert.equal(existsSync(join(dest, 'apps/web/uncommitted.txt')), false)
  assert.equal(existsSync(join(dest, 'node_modules')), false)
  assert.equal(existsSync(join(dest, 'apps/web/node_modules')), false)
  // The install step reads the store the checkout was installed from.
  assert.equal(checkoutStoreDir(root), '/store/v11')
  rmSync(join(root, 'node_modules'), { recursive: true })
  assert.throws(() => checkoutStoreDir(root), /run pnpm install/)
})

test('prepare runs with the export defaults and the chosen inputs', () => {
  const calls = []
  const prepare = (options) => {
    calls.push(options)
    return { ok: true, actions: [] }
  }
  runPrepareStep(
    {
      LOCAL_CAPTURE_PREPARE: JSON.stringify({
        persistTo: '/persist',
        certs: null,
        vars: '/run/dev.vars',
      }),
    },
    { prepare },
  )
  const [options] = calls
  assert.equal(options.requireFixtures, true)
  assert.equal(options.persistTo, '/persist')
  assert.deepEqual(options.paths, { certs: null, vars: '/run/dev.vars' })
  // No command or directory overrides: Wrangler, D1 and the fixture build
  // resolve in the export this step runs from.
  assert.deepEqual(Object.keys(options).sort(), [
    'env',
    'paths',
    'persistTo',
    'requireFixtures',
  ])
  assert.throws(
    () => runPrepareStep({}, { prepare }),
    /LOCAL_CAPTURE_PREPARE needs persistTo, certs and vars/,
  )
  // A failed setup keeps its reason but not a `pnpm dev:setup` recovery
  // command, which would act on the checkout or a removed runtime directory.
  const failed = runPrepareStep(
    {
      LOCAL_CAPTURE_PREPARE: JSON.stringify({
        persistTo: '/persist',
        certs: null,
        vars: '/run/dev.vars',
      }),
    },
    {
      prepare: () => ({
        ok: false,
        actions: [],
        reason: 'Static-site fixtures not built (next-export): exit code 1.',
        recoveryCommand: 'pnpm fixtures:build',
      }),
    },
  )
  assert.equal(failed.ok, false)
  assert.equal(failed.recoveryCommand, undefined)
  assert.match(failed.reason, /^Static-site fixtures not built/)
  assert.match(failed.reason, /rerun the capture command/)
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

test('a check still running at the deadline is aborted then and not ready', async () => {
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
})

// Checks that each wait until both have started (checks run one after another
// would never get there) and then until the test releases them.
function heldChecks(names) {
  const started = []
  let release
  const released = new Promise((done) => {
    release = done
  })
  const checks = names.map((name) => ({
    name,
    check: async () => {
      started.push(name)
      await released
    },
  }))
  return { checks, started, release }
}

test('a round whose parallel checks all pass before the deadline is ready', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const held = heldChecks(['app on ::1', 'sandbox on ::1'])
  const ready = waitUntilReady({ checks: held.checks, timeoutMs: 1_000 })
  await Promise.resolve()
  await Promise.resolve()
  assert.deepEqual(held.started, ['app on ::1', 'sandbox on ::1'])
  t.mock.timers.tick(999)
  held.release()
  await ready
})

test('checks that pass only after the deadline are not ready', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const held = heldChecks(['app on ::1', 'sandbox on ::1'])
  const ready = waitUntilReady({ checks: held.checks, timeoutMs: 1_000 })
  await Promise.resolve()
  await Promise.resolve()
  assert.deepEqual(held.started, ['app on ::1', 'sandbox on ::1'])
  // LOCAL_CAPTURE_READY_TIMEOUT_MS=1000 with answers arriving at 1500 ms.
  t.mock.timers.tick(1_500)
  held.release()
  await assert.rejects(
    ready,
    (error) =>
      /not ready within 1s/.test(error.message) &&
      /app on ::1: no answer before the deadline/.test(error.message) &&
      /sandbox on ::1: no answer before the deadline/.test(error.message),
  )
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

for (const [outcome, status] of [
  ['success', 0],
  ['failure', 1],
  ['SIGTERM', 143],
]) {
  test(`the fake Stripe serves the services from their start and is released after ${outcome}`, async (t) => {
    const dir = tempDir(t)
    const seen = join(dir, 'stripe-seen')
    const origins = []
    const waitForApp = `const wait = setInterval(() => { if (!require('fs').existsSync(${JSON.stringify(seen)})) return; clearInterval(wait); ${outcome === 'failure' ? 'process.exit(3)' : outcome === 'SIGTERM' ? `require('fs').writeFileSync(${JSON.stringify(join(dir, 'capturing'))}, ''); setInterval(() => {}, 1000)` : ''} }, 20)`
    // As soon as it starts, the app reads a fixture subscription through
    // the Stripe settings it was given, and records the answer.
    const readStripe = (vars) => `
      const fs = require('fs')
      const settings = Object.fromEntries(fs.readFileSync(${JSON.stringify(vars)}, 'utf8').split('\\n').map((line) => line.split('=')))
      fetch(settings.STRIPE_API_ORIGIN + '/v1/subscriptions/sub_capture_dev-screen-team-settings-billing-subscribed', {
        headers: { authorization: 'Bearer ' + settings.STRIPE_SECRET_KEY },
        signal: AbortSignal.timeout(5000),
      }).then(
        async (response) => ({ origin: settings.STRIPE_API_ORIGIN, status: response.status, workspace: (await response.json()).metadata?.workspace_id }),
        (error) => ({ origin: settings.STRIPE_API_ORIGIN, error: String(error) }),
      ).then((result) => fs.writeFileSync(${JSON.stringify(seen)}, JSON.stringify(result)))
      setInterval(() => {}, 1000)
    `
    const run = fakeRun(t, undefined, {
      commands: ({ inputs }) => ({
        setup: [],
        services: [node('app', readStripe(inputs.vars.path))],
        capture: node('capture', waitForApp),
      }),
      stripe: async () => {
        const fake = await startCaptureStripe()
        // A listener the lifecycle leaked fails the release check below;
        // this keeps it from also holding the test process open.
        t.after(() => fake.close().catch(() => {}))
        origins.push(fake.origin)
        return fake
      },
    })
    if (outcome === 'SIGTERM') {
      await until(() => existsSync(join(dir, 'capturing')), 'the capture')
      run.signals.emit('SIGTERM')
    }
    assert.equal(await run.result, status, run.lines.join('\n'))
    assert.equal(origins.length, 1)
    assert.deepEqual(JSON.parse(readFileSync(seen, 'utf8')), {
      origin: origins[0],
      status: 200,
      workspace: 'dev-screen-team-settings-billing-subscribed',
    })
    // Released means nothing accepts a fresh connection: a listener that
    // accepts and stays silent, or no answer at all, is not released.
    const { hostname, port } = new URL(origins[0])
    const fresh = await new Promise((done) => {
      const socket = connect({ host: hostname, port: Number(port) })
      const timer = setTimeout(() => {
        socket.destroy()
        done('timeout')
      }, 2000)
      socket.once('connect', () => {
        clearTimeout(timer)
        socket.destroy()
        done('connected')
      })
      socket.once('error', (error) => {
        clearTimeout(timer)
        done(error.code)
      })
    })
    assert.equal(fresh, 'ECONNREFUSED')
  })
}

test('a fake Stripe that cannot listen fails the capture before any service starts', async (t) => {
  const dir = tempDir(t)
  const started = join(dir, 'started')
  const touch = `require('fs').writeFileSync(${JSON.stringify(started)}, '')`
  const run = fakeRun(
    t,
    {
      setup: [],
      services: [node('app', `${touch}; setInterval(() => {}, 1000)`)],
      capture: node('capture', touch),
    },
    // Not an address of this machine: the listen itself fails.
    { stripe: () => startCaptureStripe({ host: '192.0.2.1' }) },
  )
  assert.equal(await run.result, 1)
  assert.match(run.lines.join('\n'), /fake Stripe could not listen/)
  assert.equal(existsSync(started), false)
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

// A process table the test edits: `procs` maps a PID to its parent, group and
// whether its environment carries the invocation's ownership tag. `events`
// records every read of the table or the tags and every signal, in order.
function fakeProcesses(procs) {
  const kills = []
  const events = []
  const children = new Map()
  const owner = new OwnedProcesses({
    spawnProcess: (_command, _args, options) => {
      const child = new EventEmitter()
      child.pid = Number(options.cwd)
      children.set(child.pid, child)
      return child
    },
    table: (pids) => {
      events.push(pids ? `table ${pids.join(',')}` : 'table')
      return [...procs.values()].filter(
        (row) => !pids || pids.includes(row.pid),
      )
    },
    tagged: () => {
      events.push('tagged')
      return [...procs.values()].filter((row) => row.tag).map((row) => row.pid)
    },
    hasTag: (pid) => {
      events.push(`tag ${pid}`)
      return procs.get(pid)?.tag === true
    },
    kill: (target, signal) => {
      kills.push([target, signal])
      events.push(`kill ${target} ${signal}`)
      procs.onKill?.(target, signal)
    },
    graceMs: 30,
    killWaitMs: 30,
    pollMs: 5,
  })
  const start = (pid) => owner.start({ name: `child ${pid}`, cwd: String(pid) })
  const exit = (pid) => {
    procs.delete(pid)
    children.get(pid).emit('exit', 0, null)
  }
  return { owner, kills, events, start, exit }
}

test('a reaped child whose PID is reused by an unowned process is not signalled', async () => {
  const procs = new Map([
    [4100, { pid: 4100, ppid: process.pid, pgid: 4100, tag: true }],
  ])
  const run = fakeProcesses(procs)
  run.start(4100)
  run.exit(4100)
  // Reused within the same second by a process that is not ours.
  procs.set(4100, { pid: 4100, ppid: 1, pgid: 4100, tag: false })
  await run.owner.stopAll()
  assert.deepEqual(run.kills, [])
  assert.ok(procs.has(4100))
})

test('ownership is checked again after a group signal, before each individual signal', async () => {
  const procs = new Map([
    // An owned leader that ignores SIGTERM, an owned member of its group,
    // and an owned descendant in a group of its own.
    [4200, { pid: 4200, ppid: process.pid, pgid: 4200, tag: true }],
    [4201, { pid: 4201, ppid: 4200, pgid: 4200, tag: true }],
    [4202, { pid: 4202, ppid: 1, pgid: 4202, tag: true }],
  ])
  const run = fakeProcesses(procs)
  run.start(4200)
  procs.onKill = (target, signal) => {
    if (target === -4200 && signal === 'SIGTERM') {
      // The group signal ends both members; their numbers are reused at
      // once by processes that are not ours.
      procs.set(4201, { pid: 4201, ppid: 1, pgid: 4201, tag: false })
      procs.set(4202, { pid: 4202, ppid: 1, pgid: 4202, tag: false })
    }
    if (target === -4200 && signal === 'SIGKILL') run.exit(4200)
  }
  // The reused numbers are reported, not signalled, so cleanup cannot pass.
  await assert.rejects(
    run.owner.stopAll(),
    /could no longer be proved its own, so they were not signalled: 4201, 4202/,
  )
  assert.deepEqual(run.kills, [
    [-4200, 'SIGTERM'],
    [-4200, 'SIGKILL'],
  ])
})

test('a descendant that loses its proof of ownership is reported and fails cleanup, unsignalled', async () => {
  const procs = new Map([
    [4400, { pid: 4400, ppid: process.pid, pgid: 4400, tag: true }],
    // Untagged and in a group of its own: owned only through its parent.
    [4401, { pid: 4401, ppid: 4400, pgid: 4401, tag: false }],
  ])
  const run = fakeProcesses(procs)
  run.start(4400)
  procs.onKill = (target) => {
    if (target !== -4400) return
    // The parent exits on the group signal; the descendant is reparented
    // and keeps running with nothing left to prove it is ours.
    run.exit(4400)
    procs.set(4401, { pid: 4401, ppid: 1, pgid: 4401, tag: false })
  }
  await assert.rejects(
    run.owner.stopAll(),
    /could no longer be proved its own, so they were not signalled: 4401/,
  )
  assert.deepEqual(run.kills, [[-4400, 'SIGTERM']])
  assert.ok(procs.has(4401))
})

test('an owned descendant outside the group is signalled by PID after a fresh check', async () => {
  const procs = new Map([
    [4300, { pid: 4300, ppid: process.pid, pgid: 4300, tag: true }],
    // Left the group and cleared its environment: owned only as a live
    // descendant of the tracked child.
    [4301, { pid: 4301, ppid: 4300, pgid: 4301, tag: false }],
  ])
  const run = fakeProcesses(procs)
  run.start(4300)
  procs.onKill = (target, signal) => {
    // The leader ignores SIGTERM, so it is still unreaped when 4301 is checked.
    if (target === -4300 && signal === 'SIGKILL') run.exit(4300)
    if (target === 4301) procs.delete(4301)
  }
  await run.owner.stopAll()
  assert.deepEqual(run.kills, [
    [-4300, 'SIGTERM'],
    [4301, 'SIGTERM'],
    [-4300, 'SIGKILL'],
  ])
})

test('ownership is read again before every individual signal, so a PID reused between them is refused', async () => {
  const procs = new Map([
    [4500, { pid: 4500, ppid: process.pid, pgid: 4500, tag: true }],
  ])
  // Owned descendants that left the group, each stopped by its own signal.
  const outside = [4501, 4502, 4503, 4504]
  for (const pid of outside)
    procs.set(pid, { pid, ppid: 1, pgid: pid, tag: true })
  const run = fakeProcesses(procs)
  run.start(4500)
  procs.onKill = (target, signal) => {
    if (target === 4501)
      // Signalling one ends another; its number is reused at once by a
      // process that is not ours.
      procs.set(4502, { pid: 4502, ppid: 1, pgid: 4502, tag: false })
    if (target === -4500 && signal === 'SIGKILL') run.exit(4500)
    if (target > 0) procs.delete(target)
  }
  await assert.rejects(
    run.owner.stopAll(),
    /could no longer be proved its own, so they were not signalled: 4502$/,
  )
  assert.ok(!run.kills.some(([target]) => target === 4502))
  // Each individual signal follows its own read of the table and the tags.
  const step = run.events.slice(
    run.events.indexOf('kill -4500 SIGTERM') + 1,
    run.events.indexOf('kill 4504 SIGTERM') + 1,
  )
  assert.deepEqual(step, [
    // One read of the tracked PIDs, then a fresh proof per individual
    // signal: the table, and the tag of each process on the ancestor chain.
    'table 4500,4501,4502,4503,4504',
    'table',
    'tag 4501',
    'kill 4501 SIGTERM',
    // 4502 is refused from this read.
    'table',
    'tag 4502',
    'table',
    'tag 4503',
    'kill 4503 SIGTERM',
    'table',
    'tag 4504',
    'kill 4504 SIGTERM',
  ])
})

test('members of an owned group are reached by the group signal without a proof read each', async () => {
  const procs = new Map([
    // A leader that ignores SIGTERM and owned members of its group.
    [4600, { pid: 4600, ppid: process.pid, pgid: 4600, tag: true }],
    [4601, { pid: 4601, ppid: 4600, pgid: 4600, tag: true }],
    [4602, { pid: 4602, ppid: 4600, pgid: 4600, tag: true }],
    [4603, { pid: 4603, ppid: 4601, pgid: 4600, tag: true }],
  ])
  const run = fakeProcesses(procs)
  run.start(4600)
  procs.onKill = (target, signal) => {
    if (target === -4600 && signal === 'SIGKILL') {
      for (const pid of [4601, 4602, 4603]) procs.delete(pid)
      run.exit(4600)
    }
  }
  await run.owner.stopAll()
  assert.deepEqual(run.kills, [
    [-4600, 'SIGTERM'],
    [-4600, 'SIGKILL'],
  ])
  // After the group signal: one read of the tracked PIDs, no ownership-tag
  // read for the members, then the grace-period poll.
  const after = run.events.indexOf('kill -4600 SIGTERM')
  assert.deepEqual(run.events.slice(after + 1, after + 3), [
    'table 4600,4601,4602,4603',
    'table 4600,4601,4602,4603',
  ])
})

test('an uncaught exception stops every owned process, removes the runtime root and exits nonzero', async (t) => {
  const dir = tempDir(t)
  const service = join(dir, 'service.pid')
  const run = fakeRun(t, {
    setup: [],
    services: [
      node(
        'app',
        `require('fs').writeFileSync(${JSON.stringify(service)}, String(process.pid)); setInterval(() => {}, 1000)`,
      ),
    ],
    capture: node('capture', 'setInterval(() => {}, 1000)'),
  })
  await until(() => existsSync(service), 'the service to start')
  run.signals.emit('uncaughtException', new Error('boom in a library'))
  assert.equal(await run.result, 1)
  assert.equal(alive(Number(readFileSync(service, 'utf8'))), false)
  assert.equal(existsSync(run.runtime().root), false)
  assert.match(
    run.lines.join('\n'),
    /Uncaught exception in local capture: .*boom/,
  )
  assert.equal(run.signals.listenerCount('uncaughtException'), 0)
})

for (const [phase, signal, status] of [
  ['setup', 'SIGINT', 130],
  ['setup', 'SIGHUP', 129],
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
