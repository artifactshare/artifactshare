import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import * as fs from 'node:fs/promises'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  PIN,
  downloadArchive,
  extractLibraries,
  replaceWebkitLibsoup,
  selectedWebkitDirectory,
  verifyFile,
} from './ci/replace-webkit-libsoup.mjs'

const script = fileURLToPath(
  new URL('./ci/replace-webkit-libsoup.mjs', import.meta.url),
)
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex')
const originals = ['original WPE', 'original GTK']
const replacements = ['fixed WPE', 'fixed GTK']
const archiveBytes = 'fixture archive'

async function fixture(t) {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'libsoup-test-')),
  )
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const directory = path.join(root, 'webkit-2359')
  const executable = path.join(directory, 'pw_run.sh')
  const pin = {
    ...PIN,
    size: Buffer.byteLength(archiveBytes),
    sha256: digest(archiveBytes),
    libraries: PIN.libraries.map((library, i) => ({
      ...library,
      original: digest(originals[i]),
      replacement: digest(replacements[i]),
    })),
  }
  const targets = pin.libraries.map((library) =>
    path.join(directory, library.path),
  )
  for (const [i, target] of targets.entries()) {
    await fs.mkdir(path.dirname(target), { recursive: true })
    await fs.writeFile(target, originals[i], { mode: 0o751 })
    await fs.symlink(
      path.basename(target),
      path.join(path.dirname(target), 'libsoup-3.0.so.0'),
    )
  }
  await fs.writeFile(executable, 'fixture executable')
  const events = []
  const logs = []
  const options = {
    pin,
    wait: (delay) => Promise.resolve(events.push(`wait ${delay}`)),
    platform: 'linux',
    temporaryRoot: root,
    resolveExecutable: () => executable,
    download: (input, destination) => {
      events.push('download')
      assert.equal(input, pin)
      return fs.writeFile(destination, archiveBytes)
    },
    extract: async (archive, staging, libraries) => {
      events.push('extract')
      assert.equal(await fs.readFile(archive, 'utf8'), archiveBytes)
      for (const [i, library] of libraries.entries()) {
        const destination = path.join(staging, library.path)
        await fs.mkdir(path.dirname(destination), { recursive: true })
        await fs.writeFile(destination, replacements[i])
      }
    },
    copy: (source, target) => {
      events.push('write')
      return fs.copyFile(source, target)
    },
    log: (message) => logs.push(message),
  }
  return { root, directory, executable, pin, targets, events, logs, options }
}

async function assertClean(f) {
  assert.ok(
    (await fs.readdir(f.root)).every((name) =>
      ['webkit-2359', 'cache'].includes(name),
    ),
  )
}

async function assertOriginals(f) {
  for (const [i, target] of f.targets.entries())
    assert.equal(await fs.readFile(target, 'utf8'), originals[i])
}

test('production pins are immutable and match the supplied archive and library hashes', () => {
  assert.equal(
    PIN.url,
    'https://cdn.playwright.dev/dbazure/download/playwright/builds/webkit/2370/webkit-ubuntu-24.04.zip',
  )
  assert.equal(PIN.size, 108122739)
  assert.equal(
    PIN.sha256,
    '63b31a5d68d908d9aee2e445b88edc4c1e1d1eba488f5bd7e35668f91315b968',
  )
  assert.deepEqual(PIN.libraries, [
    {
      path: 'minibrowser-wpe/sys/lib/libsoup-3.0.so.0.7.4',
      original:
        '03d635a54478e3aefd5fb202e53c8897431a6c9aaaad0408698c4b2c3a1275a3',
      replacement:
        '47ac78474975d417b377a68cbbea58794a90c533f8ec93f6d2c6d96312956bd7',
    },
    {
      path: 'minibrowser-gtk/sys/lib/libsoup-3.0.so.0.7.4',
      original:
        '0f02328d13684e0eadca97f1477eca3b244b8b446727dec628587a66c451a39d',
      replacement:
        '81839c7074fc8c105bb130dfc9080e72751e69b4f61ce60e4f17af65066eabe1',
    },
  ])
  assert.ok(Object.isFrozen(PIN) && Object.isFrozen(PIN.libraries))
  for (const library of PIN.libraries) assert.ok(Object.isFrozen(library))
})

test('selected executable requires the exact revision and layout', () => {
  for (const executable of [
    undefined,
    '',
    'webkit-2359/pw_run.sh',
    '/cache/webkit-2370/pw_run.sh',
    '/cache/webkit-2400/pw_run.sh',
    '/cache/webkit-2359-extra/pw_run.sh',
    '/cache/webkit-2359/other',
    '/cache/webkit-2359/nested/pw_run.sh',
  ]) {
    assert.throws(
      () => selectedWebkitDirectory(executable),
      /removed or re-pinned/,
    )
  }
  assert.equal(
    selectedWebkitDirectory('/cache/webkit-2359/pw_run.sh'),
    '/cache/webkit-2359',
  )
})

test('workspace Playwright resolves default, absolute, relative, INIT_CWD and hermetic paths independently of script cwd', async (t) => {
  const f = await fixture(t)
  const require = createRequire(
    new URL('../apps/web/package.json', import.meta.url),
  )
  // Resolve the transitive core dependency from the selected Playwright package.
  // The web workspace does not directly depend on playwright-core.
  const playwrightRequire = createRequire(
    require.resolve('playwright/package.json'),
  )
  const coreRoot = path.dirname(
    playwrightRequire.resolve('playwright-core/package.json'),
  )
  const cases = [
    [{}, path.join(os.homedir(), '.cache/ms-playwright')],
    [
      { PLAYWRIGHT_BROWSERS_PATH: path.join(f.root, 'custom') },
      path.join(f.root, 'custom'),
    ],
    [{ PLAYWRIGHT_BROWSERS_PATH: 'relative' }, path.join(f.root, 'relative')],
    [
      {
        PLAYWRIGHT_BROWSERS_PATH: 'relative',
        INIT_CWD: path.join(f.root, 'initial'),
      },
      path.join(f.root, 'initial/relative'),
    ],
    [{ PLAYWRIGHT_BROWSERS_PATH: '0' }, path.join(coreRoot, '.local-browsers')],
  ]
  for (const [overrides, expected] of cases) {
    const env = { ...process.env }
    for (const key of [
      'PLAYWRIGHT_BROWSERS_PATH',
      'INIT_CWD',
      'XDG_CACHE_HOME',
    ])
      delete env[key]
    const result = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `Object.defineProperty(process, 'platform', { value: 'linux' }); const {selectedExecutablePath} = await import(${JSON.stringify(new URL('./ci/replace-webkit-libsoup.mjs', import.meta.url).href)}); console.log(selectedExecutablePath())`,
      ],
      { cwd: f.root, env: { ...env, ...overrides }, encoding: 'utf8' },
    )
    assert.equal(result.status, 0, result.stderr)
    assert.equal(
      result.stdout.trim(),
      path.join(expected, 'webkit-2359/pw_run.sh'),
    )
  }
})

test('new selected revision cannot be hidden by a stale r2359 cache; missing executable fails before download', async (t) => {
  const f = await fixture(t)
  f.options.cacheDirectory = await seedCache(f)
  f.options.verify = (filename, ...args) => {
    if (filename.startsWith(f.options.cacheDirectory))
      f.events.push('cache read')
    return verifyFile(filename, ...args)
  }
  for (const executable of [
    path.join(f.root, 'webkit-2370/pw_run.sh'),
    path.join(f.root, 'missing/webkit-2359/pw_run.sh'),
  ]) {
    await assert.rejects(
      replaceWebkitLibsoup({
        ...f.options,
        resolveExecutable: () => executable,
      }),
      /removed or re-pinned/,
    )
    assert.deepEqual(f.events, [])
  }
  await assertOriginals(f)
})

for (const index of [0, 1]) {
  for (const state of ['wrong', 'missing', 'patched', 'symlink']) {
    test(`original ${index} ${state} fails before downloading or writing`, async (t) => {
      const f = await fixture(t)
      f.options.cacheDirectory = await seedCache(f)
      f.options.verify = (filename, ...args) => {
        if (filename.startsWith(f.options.cacheDirectory))
          f.events.push('cache read')
        return verifyFile(filename, ...args)
      }
      if (state === 'missing' || state === 'symlink')
        await fs.unlink(f.targets[index])
      if (state === 'symlink') await fs.symlink(f.executable, f.targets[index])
      if (state === 'wrong' || state === 'patched')
        await fs.writeFile(
          f.targets[index],
          state === 'patched' ? replacements[index] : 'wrong',
        )
      await assert.rejects(
        replaceWebkitLibsoup(f.options),
        /removed or re-pinned/,
      )
      assert.deepEqual(f.events, [])
      await assertClean(f)
    })
  }
}

test('successful patch preserves permissions, symlinks and unrelated contents, logs both hashes, and rejects a repeat', async (t) => {
  const f = await fixture(t)
  await replaceWebkitLibsoup(f.options)
  assert.deepEqual(f.events, ['download', 'extract', 'write', 'write'])
  for (const [i, target] of f.targets.entries()) {
    await verifyFile(target, f.pin.libraries[i].replacement)
    assert.equal((await fs.stat(target)).mode & 0o777, 0o751)
    assert.equal(
      await fs.readlink(path.join(path.dirname(target), 'libsoup-3.0.so.0')),
      path.basename(target),
    )
    assert.equal(
      f.logs[i],
      `Replaced ${target}: ${f.pin.libraries[i].original} -> ${f.pin.libraries[i].replacement}`,
    )
  }
  assert.equal(await fs.readFile(f.executable, 'utf8'), 'fixture executable')
  await assertClean(f)
  f.events.length = 0
  await assert.rejects(replaceWebkitLibsoup(f.options), /removed or re-pinned/)
  assert.deepEqual(f.events, [])
})

for (const failure of [
  'download',
  'archive size',
  'archive hash',
  'extraction',
  'missing 0',
  'missing 1',
  'hash 0',
  'hash 1',
]) {
  test(`${failure} failure leaves both originals untouched and removes staging`, async (t) => {
    const f = await fixture(t)
    const extract = f.options.extract
    if (failure === 'download')
      f.options.download = () =>
        Promise.reject(new Error('network unavailable'))
    if (failure === 'archive size')
      f.options.pin = { ...f.pin, size: f.pin.size + 1 }
    if (failure === 'archive hash')
      f.options.pin = { ...f.pin, sha256: digest('wrong') }
    // Keep the real tiny download even when the expected archive pins are wrong.
    if (failure.startsWith('archive'))
      f.options.download = (_, destination) =>
        fs.writeFile(destination, archiveBytes)
    if (failure === 'extraction')
      f.options.extract = () => Promise.reject(new Error('unzip failed'))
    if (failure.startsWith('missing') || failure.startsWith('hash')) {
      f.options.extract = async (...args) => {
        await extract(...args)
        const filename = path.join(
          args[1],
          f.pin.libraries[Number(failure.at(-1))].path,
        )
        if (failure.startsWith('missing')) await fs.unlink(filename)
        else await fs.writeFile(filename, 'wrong extracted bytes')
      }
    }
    await assert.rejects(replaceWebkitLibsoup(f.options), /workaround failed/)
    assert.ok(!f.events.includes('write'))
    assert.ok(!f.logs.some((message) => message.startsWith('Replaced ')))
    await assertOriginals(f)
    await assertClean(f)
  })
}

for (const failure of ['write', 'readback']) {
  test(`${failure} failure propagates without success logs and cleans staging`, async (t) => {
    const f = await fixture(t)
    let writes = 0
    f.options.copy = (source, target) => {
      writes++
      if (failure === 'write' && writes === 2)
        return Promise.reject(new Error('write denied'))
      return failure === 'readback'
        ? fs.writeFile(target, 'corrupt write')
        : fs.copyFile(source, target)
    }
    await assert.rejects(
      replaceWebkitLibsoup(f.options),
      failure === 'write' ? /write denied/ : /SHA-256 mismatch/,
    )
    assert.ok(!f.logs.some((message) => message.startsWith('Replaced ')))
    await assertClean(f)
  })
}

test('downloader checks HTTP, transport errors, actual byte counts and finite timeout offline', async (t) => {
  const f = await fixture(t)
  const destination = path.join(f.root, 'download.zip')
  const pin = { url: 'https://example.invalid/fixture', size: 3 }
  await assert.rejects(
    downloadArchive(pin, destination, () =>
      Promise.reject(new Error('network error')),
    ),
    /network error/,
  )
  await assert.rejects(
    downloadArchive(pin, destination, () =>
      Promise.resolve(new Response('', { status: 503 })),
    ),
    /HTTP 503/,
  )
  for (const body of ['ab', 'abcd', 'abc']) {
    await fs.rm(destination, { force: true })
    const operation = downloadArchive(pin, destination, (url, { signal }) => {
      assert.equal(url, pin.url)
      assert.ok(signal instanceof AbortSignal)
      return Promise.resolve(
        new Response(body, { headers: { 'Content-Length': '999' } }),
      )
    })
    if (body === 'abc') {
      await operation
      assert.equal(await fs.readFile(destination, 'utf8'), body)
    } else await assert.rejects(operation, /byte count/)
  }
})

test('unzip receives only the two exact entry names and extraction errors propagate', async () => {
  await extractLibraries(
    '/tmp/archive.zip',
    '/tmp/staging',
    PIN.libraries,
    (command, args, options) => {
      assert.equal(command, 'unzip')
      assert.deepEqual(args, [
        '-q',
        '/tmp/archive.zip',
        ...PIN.libraries.map((library) => library.path),
        '-d',
        '/tmp/staging',
      ])
      assert.equal(options.timeout, 60_000)
      return Promise.resolve()
    },
  )
  await assert.rejects(
    extractLibraries('archive', 'staging', PIN.libraries, () =>
      Promise.reject(new Error('unzip exit 9')),
    ),
    /unzip exit 9/,
  )
})

test('CLI fails nonzero before network on missing installation; importing has no patch side effects', async (t) => {
  const f = await fixture(t)
  const env = {
    ...process.env,
    PLAYWRIGHT_BROWSERS_PATH: path.join(f.root, 'absent'),
  }
  const result = spawnSync(process.execPath, [script], {
    env,
    encoding: 'utf8',
  })
  assert.equal(result.status, 1)
  assert.match(result.stderr, /removed or re-pinned/)
  assert.equal(result.stdout, '')
  const imported = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `await import(${JSON.stringify(new URL('./ci/replace-webkit-libsoup.mjs', import.meta.url).href)})`,
    ],
    { env, encoding: 'utf8' },
  )
  assert.equal(imported.status, 0, imported.stderr)
  assert.equal(imported.stdout, '')
  await assertClean(f)
})

for (const index of [0, 1]) {
  for (const failure of ['corrupt', 'missing']) {
    test(`final installed library ${index} ${failure} fails verification without success logs`, async (t) => {
      const f = await fixture(t)
      f.options.copy = (source, target) => {
        if (target !== f.targets[index]) return fs.copyFile(source, target)
        return fs.writeFile(target, 'corrupt final bytes')
      }
      if (failure === 'missing') {
        f.options.verify = (filename, expected, size) => {
          if (
            filename === f.targets[index] &&
            expected === f.pin.libraries[index].replacement
          ) {
            return Promise.reject(new Error('read-back unavailable'))
          }
          return verifyFile(filename, expected, size)
        }
      }
      await assert.rejects(
        replaceWebkitLibsoup(f.options),
        failure === 'missing' ? /read-back unavailable/ : /SHA-256 mismatch/,
      )
      assert.ok(!f.logs.some((message) => message.startsWith('Replaced ')))
      await assertClean(f)
    })
  }
}

async function seedCache(f) {
  const cache = path.join(f.root, 'cache')
  for (const [i, library] of f.pin.libraries.entries()) {
    const filename = path.join(cache, library.path)
    await fs.mkdir(path.dirname(filename), { recursive: true })
    await fs.writeFile(filename, replacements[i])
  }
  return cache
}

for (const failure of [
  'network',
  '503',
  '429',
  'truncated',
  'oversized',
  'hash',
  'interrupted',
  'timeout',
]) {
  test(`archive ${failure} retries once with clean exclusive destination`, async (t) => {
    const f = await fixture(t)
    let attempts = 0
    const delays = []
    if (failure === 'timeout') {
      t.mock.method(AbortSignal, 'timeout', (milliseconds) => {
        assert.equal(milliseconds, 180_000)
        return attempts === 0
          ? AbortSignal.abort(new DOMException('timed out', 'TimeoutError'))
          : new AbortController().signal
      })
    }
    f.options.wait = async (delay) => {
      delays.push(delay)
      assert.deepEqual(f.events, [])
      await assertOriginals(f)
    }
    f.options.download = (pin, destination) =>
      downloadArchive(pin, destination, async () => {
        await assert.rejects(fs.lstat(destination), { code: 'ENOENT' })
        attempts++
        if (attempts > 1) return new Response(archiveBytes)
        if (failure === 'network') throw new Error('network unavailable')
        if (failure === 'timeout') return new Response(archiveBytes)
        if (failure === '503' || failure === '429')
          return new Response('', { status: Number(failure) })
        if (failure === 'interrupted')
          return new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(new TextEncoder().encode('partial'))
              },
              pull(controller) {
                controller.error(new Error('stream interrupted'))
              },
            }),
          )
        return new Response(
          failure === 'truncated'
            ? 'short'
            : failure === 'oversized'
              ? archiveBytes + 'extra'
              : 'x'.repeat(pin.size),
        )
      })
    await replaceWebkitLibsoup(f.options)
    assert.equal(attempts, 2)
    assert.deepEqual(delays, [2000])
    assert.match(f.logs[0], /attempt 1\/4 failed:/)
    assert.match(
      f.logs[0],
      failure === 'hash'
        ? /SHA-256/
        : failure === 'timeout'
          ? /aborted/
          : failure === 'network'
            ? /network unavailable/
            : failure === 'interrupted'
              ? /stream interrupted/
              : failure === '503' || failure === '429'
                ? /HTTP/
                : /byte count/,
    )
    assert.deepEqual(f.events, ['extract', 'write', 'write'])
    await assertClean(f)
  })
}

test('persistent transport failure stops at four attempts, three waits, cleans partial bytes and preserves originals', async (t) => {
  const f = await fixture(t)
  let attempts = 0
  f.options.download = (pin, destination) =>
    downloadArchive(pin, destination, () => {
      attempts++
      return Promise.resolve(new Response('partial'))
    })
  await assert.rejects(
    replaceWebkitLibsoup(f.options),
    /failed to download archive:.*byte count.*removed or re-pinned/,
  )
  assert.equal(attempts, 4)
  assert.deepEqual(f.events, ['wait 2000', 'wait 5000', 'wait 10000'])
  assert.equal(f.logs.length, 4)
  f.logs.forEach((message, index) =>
    assert.match(message, new RegExp(`attempt ${index + 1}/4 failed:`)),
  )
  await assertOriginals(f)
  await assertClean(f)
})

for (const failure of ['404', 'disk']) {
  test(`${failure} download error is terminal`, async (t) => {
    const f = await fixture(t)
    let attempts = 0
    f.options.download = async (pin, destination) => {
      attempts++
      if (failure === 'disk') await fs.writeFile(destination, 'existing')
      await downloadArchive(pin, destination, () =>
        Promise.resolve(
          new Response(archiveBytes, { status: failure === '404' ? 404 : 200 }),
        ),
      )
    }
    await assert.rejects(
      replaceWebkitLibsoup(f.options),
      failure === '404' ? /HTTP 404/ : /EEXIST/,
    )
    assert.equal(attempts, 1)
    assert.deepEqual(f.events, [])
    await assertOriginals(f)
    await assertClean(f)
  })
}

for (const state of [
  'valid',
  'missing directory',
  'missing member',
  'wrong 0',
  'wrong 1',
  'directory',
  'symlink',
]) {
  for (const suffix of ['', path.sep]) {
    test(`cache ${state}${suffix ? ' with trailing slash' : ''} selects a complete verified source and supports reuse`, async (t) => {
      const f = await fixture(t)
      const cache = await seedCache(f)
      const member = path.join(
        cache,
        f.pin.libraries[state === 'wrong 1' ? 1 : 0].path,
      )
      if (state === 'missing directory') await fs.rm(cache, { recursive: true })
      if (['missing member', 'directory', 'symlink'].includes(state))
        await fs.unlink(member)
      if (state.startsWith('wrong')) await fs.writeFile(member, 'bad')
      if (state === 'directory') await fs.mkdir(member)
      if (state === 'symlink') await fs.symlink(f.targets[0], member)
      f.options.cacheDirectory = cache + suffix
      await replaceWebkitLibsoup(f.options)
      assert.deepEqual(
        f.events,
        state === 'valid'
          ? ['write', 'write']
          : ['download', 'extract', 'write', 'write'],
      )
      if (state !== 'valid') assert.match(f.logs[0], /cache rejected:/)
      for (const [i, library] of f.pin.libraries.entries()) {
        await verifyFile(path.join(cache, library.path), library.replacement)
        assert.equal((await fs.stat(f.targets[i])).mode & 0o777, 0o751)
        assert.equal(
          await fs.readlink(
            path.join(path.dirname(f.targets[i]), 'libsoup-3.0.so.0'),
          ),
          path.basename(f.targets[i]),
        )
        await fs.writeFile(f.targets[i], originals[i])
      }
      f.events.length = 0
      await replaceWebkitLibsoup(f.options)
      assert.deepEqual(f.events, ['write', 'write'])
      assert.deepEqual((await fs.readdir(f.root)).sort(), [
        'cache',
        'webkit-2359',
      ])
    })
  }
}

for (const failure of ['archive', 'extraction', 'staged']) {
  test(`${failure} failure never publishes cache or retries later stages`, async (t) => {
    const f = await fixture(t)
    f.options.cacheDirectory = path.join(f.root, 'cache')
    if (failure === 'archive')
      f.options.download = (_, destination) => fs.writeFile(destination, 'bad')
    if (failure === 'extraction')
      f.options.extract = () => Promise.reject(new Error('unzip failed'))
    if (failure === 'staged') {
      const extract = f.options.extract
      f.options.extract = async (...args) => {
        await extract(...args)
        await fs.writeFile(path.join(args[1], f.pin.libraries[1].path), 'bad')
      }
    }
    await assert.rejects(replaceWebkitLibsoup(f.options), /workaround failed/)
    assert.equal(
      f.events.filter((event) => event === 'download').length,
      failure === 'archive' ? 0 : 1,
    )
    assert.equal(
      f.events.filter((event) => event.startsWith('wait')).length,
      failure === 'archive' ? 3 : 0,
    )
    await assert.rejects(fs.lstat(f.options.cacheDirectory), { code: 'ENOENT' })
    await assertOriginals(f)
    await assertClean(f)
  })
}

for (const phase of ['read', 'publication']) {
  test(`cache ${phase} I/O failure is terminal and cleans unpublished staging`, async (t) => {
    const f = await fixture(t)
    const cache =
      phase === 'read' ? await seedCache(f) : path.join(f.root, 'cache')
    f.options.cacheDirectory = cache
    f.options.verify = (filename, ...args) => {
      if (
        phase === 'read'
          ? filename.startsWith(`${cache}/`)
          : filename.startsWith(`${cache}.staging-`)
      )
        return Promise.reject(
          Object.assign(new Error('cache I/O failed'), { code: 'EIO' }),
        )
      return verifyFile(filename, ...args)
    }
    await assert.rejects(
      replaceWebkitLibsoup(f.options),
      /failed to (verify cached libraries|publish verified cache): cache I\/O failed/,
    )
    assert.deepEqual(f.events, phase === 'read' ? [] : ['download', 'extract'])
    if (phase === 'publication')
      await assert.rejects(fs.lstat(cache), { code: 'ENOENT' })
    await assertOriginals(f)
    await assertClean(f)
  })
}
