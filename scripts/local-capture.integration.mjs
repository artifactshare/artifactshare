// Real-service test for `pnpm screens:capture:local` and
// `pnpm walkthroughs:capture:local`, run by `pnpm test:capture:local` only:
// it starts real Wrangler/Vite services and Chromium, which unit mocks cannot
// stand in for (registry discovery, Worker persistence, dual-stack binding).
//
// Every case runs in one disposable checkout outside this tree: a clone of
// HEAD with the current working tree committed on top (so an uncommitted
// implementation is what runs), dependencies installed offline, and none of the
// git-ignored inputs (.dev.vars, certificates, schema, fixtures, CLI build).
// The reviewed tree and its developer inputs are never touched. Sentinels
// stand in for what a developer's `pnpm dev` in the same checkout reads
// (Vite and Miniflare caches, certificate and fixture directories, the
// contract build); the commands must leave them byte-for-byte unchanged and
// create none of the missing inputs in the checkout.
import assert from 'node:assert/strict'
import { execFile, execFileSync, spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { get } from 'node:https'
import { createServer } from 'node:net'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import test from 'node:test'
import { DEV_SERVICES, serviceIdentityMatches } from './dev-setup.mjs'
import { checkoutStoreDir, processTable } from './local-capture.mjs'
import { screenCaptureOutputRoot } from './screen-capture-output.mjs'

const SOURCE = resolve(import.meta.dirname, '..')
const RUN_TIMEOUT_MS = 20 * 60_000
const IDENTITY = [
  '-c',
  'user.name=local-capture-test',
  '-c',
  'user.email=local-capture-test@example.com',
]

const git = (cwd, args) =>
  execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()

function makeCheckout(base) {
  const checkout = join(base, 'checkout')
  git(base, ['clone', '--quiet', '--no-hardlinks', SOURCE, checkout])
  const files = git(SOURCE, [
    'ls-files',
    '-z',
    '--cached',
    '--others',
    '--exclude-standard',
  ])
    .split('\0')
    .filter(Boolean)
  for (const file of files) {
    const target = join(checkout, file)
    if (!existsSync(join(SOURCE, file))) {
      rmSync(target, { force: true })
      continue
    }
    mkdirSync(dirname(target), { recursive: true })
    cpSync(join(SOURCE, file), target)
  }
  git(checkout, ['add', '-A'])
  git(checkout, [
    ...IDENTITY,
    'commit',
    '--quiet',
    '--allow-empty',
    '-m',
    'working tree under test',
  ])
  // Installed offline from the store this tree was installed from, as a
  // developer's checkout is, so pnpm's own dependency check is satisfied.
  const install = spawnSync(
    'pnpm',
    [
      'install',
      '--frozen-lockfile',
      '--offline',
      '--store-dir',
      checkoutStoreDir(SOURCE),
    ],
    { cwd: checkout, encoding: 'utf8' },
  )
  // pnpm reports its errors (ERR_PNPM_NO_OFFLINE_META, a package missing
  // from the store) on stdout, so both streams go into the failure.
  if (install.error || install.status !== 0)
    throw new Error(
      `pnpm install --offline failed in the test checkout:\n${install.stdout}${install.stderr}`,
      { cause: install.error },
    )
  return checkout
}

// Every default registry location of the locked Wrangler and Miniflare under
// a test-only HOME and XDG config root, plus a registry path the caller's
// environment already names. None of them may change.
function sentinelHome(base) {
  const home = join(base, 'home')
  const config = join(home, '.config')
  const registries = [
    join(home, '.wrangler/registry'),
    join(config, '.wrangler/registry'),
    join(config, 'cloudflare/dev-registry/v5'),
    join(home, 'Library/Preferences/.wrangler/registry'),
    join(home, 'Library/Preferences/cloudflare/dev-registry/v5'),
    join(home, 'inherited-registry'),
  ]
  for (const dir of registries) {
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, 'sentinel-worker'),
      `{"sentinel":"${relative(home, dir)}"}`,
    )
  }
  const realHome = homedir()
  return {
    registries,
    env: {
      ...process.env,
      HOME: home,
      XDG_CONFIG_HOME: config,
      // Tool homes derived from HOME stay where they are installed, so pnpm
      // does not provision its pinned version again under the test HOME.
      PNPM_HOME:
        process.env.PNPM_HOME ??
        (process.platform === 'darwin'
          ? join(realHome, 'Library/pnpm')
          : join(
              process.env.XDG_DATA_HOME ?? join(realHome, '.local/share'),
              'pnpm',
            )),
      // pnpm's package metadata cache, which the export's offline install
      // reads for its supply-chain check, as the checkout's install left it.
      XDG_CACHE_HOME:
        process.env.XDG_CACHE_HOME ??
        (process.platform === 'darwin'
          ? join(realHome, 'Library/Caches')
          : join(realHome, '.cache')),
      PLAYWRIGHT_BROWSERS_PATH:
        process.env.PLAYWRIGHT_BROWSERS_PATH ??
        (process.platform === 'darwin'
          ? join(realHome, 'Library/Caches/ms-playwright')
          : join(realHome, '.cache/ms-playwright')),
      // Inherited topology that must not reach the owned stack.
      SCREEN_CAPTURE_BASE_URL: 'https://localhost:5173',
      CLOUDFLARE_DEV_REGISTRY_PATH: join(home, 'inherited-registry'),
      WRANGLER_REGISTRY_PATH: join(home, 'inherited-registry'),
    },
  }
}

// Shared checkout files an external `pnpm dev` reads. `.dev-certs` holds no
// certificate, so the commands need one and must make it elsewhere.
const CHECKOUT_SENTINELS = [
  'apps/web/node_modules/.vite/sentinel.txt',
  'apps/web/node_modules/.mf/cf.json',
  // React Router deletes and regenerates this directory when its dev server
  // starts in the directory; Wrangler writes its bundles under `.wrangler`.
  'apps/web/.react-router/types/sentinel.txt',
  'apps/web/.wrangler/sentinel.txt',
  '.dev-certs/sentinel.txt',
  'fixtures/static-sites/sentinel.txt',
  'packages/contract/dist/sentinel.txt',
]

function checkoutSentinels(checkout) {
  for (const file of CHECKOUT_SENTINELS) {
    mkdirSync(dirname(join(checkout, file)), { recursive: true })
    writeFileSync(join(checkout, file), `{"sentinel":"${file}"}`)
  }
  return CHECKOUT_SENTINELS.map((file) => dirname(join(checkout, file)))
}

function treeSnapshot(dirs) {
  const files = {}
  for (const dir of dirs)
    for (const entry of readdirSync(dir, {
      recursive: true,
      withFileTypes: true,
    })) {
      const path = join(entry.parentPath, entry.name)
      files[path] = entry.isFile()
        ? createHash('sha256').update(readFileSync(path)).digest('hex')
        : 'directory'
    }
  return files
}

// Every process any command run started, for attributing connections.
const commandPids = new Set()

// Unrelated listeners on the `pnpm dev` ports, on each loopback family that
// is free. The command must neither reuse nor stop them. Other software on a
// shared machine may probe these ports too, so each connection is attributed
// to its client process before it is answered.
async function syntheticListeners() {
  const servers = []
  const sockets = new Set()
  const clients = []
  for (const port of [5173, 5174, 5175])
    for (const host of ['127.0.0.1', '::1']) {
      const server = createServer((socket) => {
        sockets.add(socket)
        socket.once('close', () => sockets.delete(socket))
        socket.on('error', () => {})
        clients.push(
          new Promise((done) =>
            execFile(
              'lsof',
              ['-nP', '-t', `-iTCP:${socket.remotePort}`],
              { encoding: 'utf8' },
              (_error, stdout) =>
                done(
                  (stdout ?? '')
                    .split('\n')
                    .filter(Boolean)
                    .map(Number)
                    .filter((pid) => pid !== process.pid),
                ),
            ),
          ).finally(() => socket.end('synthetic unrelated listener\n')),
        )
      })
      const bound = await new Promise((done) => {
        server.once('error', () => done(false))
        server.listen({ port, host, exclusive: true }, () => done(true))
      })
      if (bound) servers.push(server)
    }
  return {
    servers,
    commandClients: async () =>
      (await Promise.all(clients)).flat().filter((pid) => commandPids.has(pid)),
    close: () => {
      for (const socket of sockets) socket.destroy()
      return Promise.all(
        servers.map((server) => new Promise((done) => server.close(done))),
      )
    },
  }
}

function alive(pid) {
  return processTable().some((row) => row.pid === pid && !row.zombie)
}

/**
 * Runs one command in the checkout, records every descendant it starts, and
 * calls `onLine` for each output line so a case can act on an acknowledgement.
 */
function runCommand(checkout, env, command, args, onLine = () => {}) {
  const child = spawn(command, args, {
    cwd: checkout,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const seen = new Set([child.pid])
  commandPids.add(child.pid)
  const watch = setInterval(() => {
    let added = true
    const rows = processTable()
    while (added) {
      added = false
      for (const row of rows)
        if (!seen.has(row.pid) && (seen.has(row.ppid) || seen.has(row.pgid))) {
          seen.add(row.pid)
          commandPids.add(row.pid)
          added = true
        }
    }
  }, 200)
  let output = ''
  const read = (stream) => {
    let pending = ''
    stream.on('data', (chunk) => {
      output += chunk
      pending += chunk
      const lines = pending.split('\n')
      pending = lines.pop()
      for (const line of lines)
        onLine(line, {
          child,
          output: () => output,
          descendants: () => [...seen].filter((pid) => pid !== child.pid),
        })
    })
  }
  read(child.stdout)
  read(child.stderr)
  const timer = setTimeout(() => child.kill('SIGKILL'), RUN_TIMEOUT_MS)
  return new Promise((done) =>
    child.on('exit', (code, signal) => {
      clearInterval(watch)
      clearTimeout(timer)
      done({
        code,
        signal,
        output,
        descendants: [...seen].filter((pid) => pid !== child.pid),
      })
    }),
  )
}

function topologyFrom(output) {
  const match =
    /local capture: app https:\/\/localhost:(\d+), sandbox https:\/\/localhost:(\d+), og-image https:\/\/localhost:(\d+); runtime (\S+)/.exec(
      output,
    )
  assert.ok(match, `no topology line in output:\n${output.slice(-4000)}`)
  return {
    app: Number(match[1]),
    sandbox: Number(match[2]),
    ogImage: Number(match[3]),
    runtime: match[4],
  }
}

// The command resolves only after every owned process is gone, so none may
// be running (zombies aside) at the moment it exits.
function assertStopped(result) {
  assert.deepEqual(
    result.descendants.filter(alive),
    [],
    'owned processes outlived the command',
  )
  assert.ok(result.descendants.length > 0, 'the command started no processes')
  assert.equal(
    existsSync(topologyFrom(result.output).runtime),
    false,
    'runtime root left behind',
  )
}

function loopbackGet(
  address,
  port,
  path,
  { headers = {}, name = 'localhost' } = {},
) {
  return new Promise((done, fail) => {
    get(
      {
        host: address,
        port,
        path,
        servername: name,
        rejectUnauthorized: false,
        headers: { host: `${name}:${port}`, ...headers },
        timeout: 30_000,
      },
      (response) => {
        let body = ''
        response.setEncoding('latin1')
        response.on('data', (chunk) => (body += chunk))
        response.on('end', () =>
          done({
            status: response.statusCode,
            contentType: response.headers['content-type'],
            body,
          }),
        )
      },
    )
      .on('timeout', function () {
        this.destroy(new Error('timeout'))
      })
      .on('error', fail)
  })
}

function processEnvironment(pid) {
  return process.platform === 'linux'
    ? readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0').join('\n')
    : execFileSync('ps', ['-E', '-ww', '-o', 'command=', '-p', String(pid)], {
        encoding: 'utf8',
      })
}

function processArgs(pid) {
  return execFileSync('ps', ['-ww', '-o', 'args=', '-p', String(pid)], {
    encoding: 'utf8',
  }).trim()
}

// Checks made while the walkthrough runs against the owned stack.
async function inspectRunningStack(checkout, topology, descendants) {
  for (const service of DEV_SERVICES) {
    const port = {
      app: topology.app,
      sandbox: topology.sandbox,
      'og-image': topology.ogImage,
    }[service.name]
    for (const address of ['127.0.0.1', '::1']) {
      const actual = await loopbackGet(address, port, service.path, {
        headers: service.headers,
      })
      assert.ok(
        serviceIdentityMatches(service.expected, actual),
        `${service.name} on ${address}:${port} answered ${actual.status}`,
      )
    }
  }
  const og = await loopbackGet('::1', topology.app, '/og-image')
  assert.equal(og.status, 200)
  assert.match(og.contentType ?? '', /^image\//)

  const registry = join(topology.runtime, 'registry')
  assert.ok(
    readdirSync(registry).includes('artifactshare-og-image-public-preview'),
    'og-image is not in the owned registry',
  )

  const running = descendants
    .filter(alive)
    .map((pid) => ({ pid, args: processArgs(pid) }))
  const wrangler = running.filter(
    ({ args }) =>
      /wrangler(-dist\/cli\.js)? dev /.test(args) &&
      args.includes('--persist-to'),
  )
  const vite = running.filter(({ args }) =>
    /react-router(\.js)? dev|@react-router\/dev\/bin\.c?js dev/.test(args),
  )
  assert.ok(
    wrangler.length >= 2,
    `wrangler services not found among:\n${running.map(({ args }) => args).join('\n')}`,
  )
  assert.ok(
    vite.length >= 1,
    `the app service was not found among:\n${running.map(({ args }) => args).join('\n')}`,
  )
  for (const { pid, args } of wrangler) {
    assert.ok(
      args.includes(`--persist-to ${join(topology.runtime, 'persist')}`),
      args,
    )
    assert.match(
      args,
      new RegExp(`--port (${topology.sandbox}|${topology.ogImage})\\b`),
    )
  }
  for (const { pid } of [...wrangler, ...vite]) {
    const env = processEnvironment(pid)
    assert.ok(
      env.includes(`CLOUDFLARE_DEV_REGISTRY_PATH=${registry}`),
      `pid ${pid} lacks the owned registry`,
    )
    assert.ok(
      env.includes(`WRANGLER_REGISTRY_PATH=${registry}`),
      `pid ${pid} lacks the owned Wrangler registry`,
    )
  }
  // Both families on loopback only: no owned process listens on a wildcard
  // or external address.
  const listening = execFileSync(
    'lsof',
    [
      '-nP',
      '-a',
      '-iTCP',
      '-sTCP:LISTEN',
      '-Fn',
      '-p',
      running.map(({ pid }) => pid).join(','),
    ],
    { encoding: 'utf8' },
  )
    .split('\n')
    .filter((line) => line.startsWith('n'))
    .map((line) => line.slice(1))
  assert.ok(listening.length > 0, 'no owned listener found')
  for (const address of listening)
    assert.match(
      address,
      /^(127\.0\.0\.1|\[::1\]):\d+$/,
      `owned listener on ${address}`,
    )
  for (const { pid } of vite) {
    const env = processEnvironment(pid)
    assert.ok(env.includes(`ARTIFACTSHARE_DEV_APP_PORT=${topology.app}`))
    assert.ok(
      env.includes(
        `ARTIFACTSHARE_DEV_PERSIST_PATH=${join(topology.runtime, 'persist')}`,
      ),
    )
  }

  // Wildcard *.localhost hosts reach the services on [::1], where Chromium
  // resolves them during a capture. Plain HTTPS requests check the routing
  // and the recovery link; the capture running at the same time loads the
  // pages with their modules in a browser.
  const viewer = await loopbackGet('::1', topology.app, '/', {
    name: 'abc123def4.localhost',
  })
  assert.ok(viewer.status < 500, `per-ID viewer host answered ${viewer.status}`)
  assert.match(viewer.contentType ?? '', /text\/html/)
  // A document without a token gets the sandbox's recovery page, which
  // links back to the viewer on the selected app port.
  const sandbox = await loopbackGet('::1', topology.sandbox, '/', {
    // A browser navigation, which is what gets the recovery page.
    headers: { 'sec-fetch-dest': 'document' },
    name: 'a-probe00000--v-70726f6265.usercontent.localhost',
  })
  assert.equal(sandbox.status, 401)
  assert.ok(
    sandbox.body.includes(
      `href="https://localhost:${topology.app}/a/probe00000?version=probe"`,
    ),
    'the sandbox recovery link does not follow the selected app port',
  )
}

test(
  'local capture commands own an isolated stack from a fresh checkout',
  { timeout: 120 * 60_000 },
  async (t) => {
    const base = mkdtempSync(join(tmpdir(), 'artifactshare-local-capture-it-'))
    t.after(() => rmSync(base, { recursive: true, force: true }))
    const checkout = makeCheckout(base)
    assert.ok(
      existsSync(join(checkout, 'scripts/local-capture.mjs')),
      'the checkout lacks the implementation',
    )
    // Inputs the commands need but must never create in the checkout.
    const absentInputs = [
      '.dev.vars',
      '.dev-certs/cert.pem',
      'fixtures/static-sites/react-spa',
      'packages/cli/dist',
    ]
    for (const input of absentInputs)
      assert.equal(
        existsSync(join(checkout, input)),
        false,
        `${input} must start missing`,
      )
    const shared = checkoutSentinels(checkout)
    const sharedBefore = treeSnapshot(shared)
    assert.equal(git(checkout, ['status', '--porcelain']), '')
    const baseCommit = git(checkout, ['rev-parse', 'HEAD'])
    const outputRoot = screenCaptureOutputRoot((file, args) =>
      git(checkout, args),
    )
    const home = sentinelHome(base)
    const sentinels = treeSnapshot(home.registries)
    const listeners = await syntheticListeners()
    t.after(() => listeners.close())
    const assertIsolated = async () => {
      assert.deepEqual(
        treeSnapshot(home.registries),
        sentinels,
        'a default registry changed',
      )
      assert.deepEqual(
        treeSnapshot(shared),
        sharedBefore,
        'a checkout file read by pnpm dev changed',
      )
      for (const input of absentInputs)
        assert.equal(
          existsSync(join(checkout, input)),
          false,
          `${input} was created in the checkout`,
        )
      assert.deepEqual(
        await listeners.commandClients(),
        [],
        'the command connected to an unrelated listener',
      )
      assert.ok(listeners.servers.every((server) => server.listening))
    }
    const commitVariant = (file, from, to) => {
      const path = join(checkout, file)
      const source = readFileSync(path, 'utf8')
      assert.ok(
        source.includes(from),
        `${file} no longer contains the fault target`,
      )
      writeFileSync(path, source.replace(from, to))
      git(checkout, [
        ...IDENTITY,
        'commit',
        '--quiet',
        '-am',
        `fault variant: ${file}`,
      ])
    }
    const restore = () =>
      git(checkout, ['reset', '--quiet', '--hard', baseCommit])

    await t.test(
      'a fresh checkout captures one screen and leaves nothing running',
      async () => {
        const result = await runCommand(checkout, home.env, 'pnpm', [
          'screens:capture:local',
          '--',
          '--screen',
          'about',
        ])
        assert.equal(result.code, 0, result.output.slice(-6000))
        assert.match(result.output, /Screen captures: 8 succeeded, 0 failed/)
        const manifest = JSON.parse(
          readFileSync(join(outputRoot, 'latest/manifest.json'), 'utf8'),
        )
        assert.equal(manifest.head ?? baseCommit, baseCommit)
        // The certificate and variables were made in the runtime directory.
        assert.match(
          result.output,
          /Generated (self-signed )?HTTPS certificates/,
        )
        assert.match(
          result.output,
          /Created \.dev\.vars from \.dev\.vars\.example/,
        )
        // The export got its own offline install, and the fixtures were
        // built there from HEAD; the checkout copy stays as it was.
        assert.match(result.output, /local capture: dependency install/)
        assert.match(result.output, /Built static-site fixtures/)
        assertStopped(result)
        await assertIsolated()
      },
    )

    await t.test(
      'a capture state whose selector matches nothing fails after cleanup',
      async () => {
        commitVariant(
          'apps/web/app/routes/_public/($locale)/about.tsx',
          "      description: '通常の About',\n      setup: {},",
          "      description: '通常の About',\n      setup: {\n        interactions: [\n          { action: 'click', selector: '[data-local-capture-missing]' },\n        ],\n      },",
        )
        try {
          const result = await runCommand(checkout, home.env, 'pnpm', [
            'screens:capture:local',
            '--',
            '--screen',
            'about',
            '--label',
            'fault',
          ])
          assert.notEqual(result.code, 0)
          assert.match(
            result.output,
            /local capture: services ready; starting the capture/,
          )
          assert.match(result.output, /capture failed: about\/default\//)
          assert.match(result.output, /data-local-capture-missing/)
          assertStopped(result)
          await assertIsolated()
        } finally {
          restore()
        }
      },
    )

    for (const [signal, status] of [
      ['SIGINT', 130],
      ['SIGHUP', 129],
    ])
      await t.test(
        `${signal} during setup stops every owned process`,
        async () => {
          const result = await runCommand(
            checkout,
            home.env,
            process.execPath,
            [
              'scripts/local-capture.mjs',
              'screens',
              '--',
              '--screen',
              'about',
              '--label',
              'interrupted',
            ],
            (line, { child }) => {
              if (line === 'local capture: prepare') child.kill(signal)
            },
          )
          assert.equal(result.code, status, result.output.slice(-4000))
          assert.doesNotMatch(result.output, /services ready/)
          assertStopped(result)
          await assertIsolated()
        },
      )

    await t.test(
      'SIGTERM during capture stops every owned process and keeps earlier evidence',
      async () => {
        const result = await runCommand(
          checkout,
          home.env,
          process.execPath,
          [
            'scripts/local-capture.mjs',
            'screens',
            '--',
            '--screen',
            'about',
            '--label',
            'interrupted',
          ],
          (line, { child }) => {
            if (line === 'local capture: services ready; starting the capture')
              child.kill('SIGTERM')
          },
        )
        assert.equal(result.code, 143, result.output.slice(-4000))
        assertStopped(result)
        assert.ok(
          existsSync(join(outputRoot, 'latest/manifest.json')),
          'earlier evidence was removed',
        )
        await assertIsolated()
      },
    )

    await t.test(
      'the share-file-link walkthrough builds the CLI and uses the owned topology',
      async () => {
        assert.equal(
          existsSync(join(checkout, 'packages/cli/dist/index.js')),
          false,
        )
        let inspection
        const result = await runCommand(
          checkout,
          home.env,
          'pnpm',
          ['walkthroughs:capture:local', '--', '--task', 'share-file-link'],
          (line, run) => {
            if (line === 'local capture: services ready; starting the capture')
              // Settled into a value so a failed check is reported, not unhandled.
              inspection = inspectRunningStack(
                checkout,
                topologyFrom(run.output()),
                run.descendants(),
              ).then(
                () => null,
                (error) => error,
              )
          },
        )
        assert.ok(inspection, 'the walkthrough never reported ready services')
        const inspectionError = await inspection
        if (inspectionError) throw inspectionError
        assert.equal(result.code, 0, result.output.slice(-6000))
        const manifest = JSON.parse(
          readFileSync(join(outputRoot, 'walkthrough/manifest.json'), 'utf8'),
        )
        assert.equal(
          manifest.baseUrl,
          `https://localhost:${topologyFrom(result.output).app}`,
        )
        assert.deepEqual(
          manifest.tasks.map((task) => [task.taskId, task.status]),
          [['share-file-link', 'success']],
        )
        const evidence = JSON.parse(
          readFileSync(
            join(outputRoot, 'walkthrough/share-file-link/evidence.json'),
            'utf8',
          ),
        )
        assert.deepEqual(
          evidence.runs.map((run) => [run.viewport, run.status]),
          [
            ['desktop', 'success'],
            ['mobile', 'success'],
          ],
        )
        assertStopped(result)
        await assertIsolated()
      },
    )

    await t.test(
      'a walkthrough step whose selector matches nothing fails after cleanup',
      async () => {
        commitVariant(
          'scripts/task-walkthroughs.mjs',
          "      phase('action', '共有リンクをコピーする', {\n        kind: 'click',\n        selector:\n          'button[aria-label=\"Copy link\"], button[aria-label=\"共有リンクをコピー\"]',",
          "      phase('action', '共有リンクをコピーする', {\n        kind: 'click',\n        selector: '[data-local-capture-missing-step]',",
        )
        try {
          const result = await runCommand(checkout, home.env, 'pnpm', [
            'walkthroughs:capture:local',
            '--',
            '--task',
            'share-file-link',
            '--label',
            'fault',
          ])
          assert.notEqual(result.code, 0)
          assert.match(
            result.output,
            /local capture: services ready; starting the capture/,
          )
          assert.match(result.output, /data-local-capture-missing-step/)
          assertStopped(result)
          await assertIsolated()
        } finally {
          restore()
        }
      },
    )
  },
)
