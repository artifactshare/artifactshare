import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { basename, dirname, join, relative, sep } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  assertSafeCaptureOutput,
  createCaptureOutput,
  removeCaptureOutput,
  screenCaptureOutputDirectory,
  screenCaptureOutputRoot,
  verifySettingsErrorEvidence,
} from './screen-capture-output.mjs'
import {
  assertCaptureSurface,
  rootErrorLogoAtTopLeft,
  navigateForCapture,
  captureRetries,
  shouldRetryCapture,
  captureScreenImages,
  fullPageCaptureStyle,
  writeCaptureReviewOutput,
  fileName,
  localSandboxOrigin,
  needsLocalSandbox,
} from './screen-capture.mjs'

function fixture(t) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'capture-output-')))
  t.after(() => rmSync(base, { recursive: true, force: true }))
  const primary = join(base, 'primary')
  mkdirSync(primary)
  const git = (cwd, args) =>
    execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
  git(primary, ['init', '--quiet'])
  git(primary, [
    '-c',
    'user.name=Capture Test',
    '-c',
    'user.email=capture@example.com',
    '-c',
    'commit.gpgsign=false',
    'commit',
    '--quiet',
    '--allow-empty',
    '-m',
    'fixture',
  ])
  return { base, primary, git }
}

test('primary and linked worktrees write to distinct deterministic roots outside each checkout', (t) => {
  const { base, primary, git } = fixture(t)
  const linked = join(base, 'linked')
  git(primary, ['worktree', 'add', '--quiet', '--detach', linked])
  const roots = [primary, linked].map((checkout) => {
    const run = (file, args) => {
      assert.equal(file, 'git')
      return git(checkout, args)
    }
    const root = screenCaptureOutputRoot(run)
    const gitDir = git(checkout, ['rev-parse', '--absolute-git-dir'])
    assert.equal(
      root,
      join(
        dirname(checkout),
        `.${basename(checkout)}-screen-captures`,
        createHash('sha256').update(gitDir).digest('hex'),
      ),
    )
    assert.equal(screenCaptureOutputRoot(run), root)
    assert.ok(relative(checkout, root).startsWith(`..${sep}`))
    mkdirSync(root, { recursive: true })
    writeFileSync(join(root, 'capture.png'), 'capture')
    assert.equal(
      git(checkout, ['status', '--porcelain', '--untracked-files=all']),
      '',
    )
    return root
  })
  assert.notEqual(roots[0], roots[1])
})

test('label verification requires the current checkout revision on every screenshot', (t) => {
  const { primary, git } = fixture(t)
  const directory = screenCaptureOutputDirectory(
    'review',
    screenCaptureOutputRoot((_file, args) => git(primary, args)),
  )
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, 'review.png'), 'screenshot')
  const entry = {
    status: 'success',
    file: 'review.png',
    head: git(primary, ['rev-parse', 'HEAD']),
  }
  const verify = (second) => {
    writeFileSync(
      join(directory, 'manifest.json'),
      JSON.stringify([entry, second]),
    )
    execFileSync(
      process.execPath,
      [
        fileURLToPath(new URL('./screen-capture-output.mjs', import.meta.url)),
        '--check-labels',
        'review',
      ],
      { cwd: primary, stdio: 'pipe' },
    )
  }
  verify(entry)
  assert.throws(
    () => verify({ ...entry, head: 'old-revision' }),
    /revision mismatch/,
  )
})

test('settings-errors verification detects a state missing from both the ledger and the manifest', async () => {
  const { screens } = await import('./screen-ledger.mjs')
  const general = screens.find((screen) => screen.id === 'settings-general')
  const manifest = []
  for (const state of general.states.filter(
    (candidate) => candidate.expectedError,
  )) {
    for (const viewport of ['desktop', 'mobile']) {
      for (const theme of ['light', 'dark']) {
        manifest.push({
          screen: general.id,
          state: state.id,
          viewport,
          theme,
          httpStatus: state.expectedStatus,
          boundaryMarker: state.expectedError,
          readySelector: state.setup.ready.selector,
        })
      }
    }
  }
  verifySettingsErrorEvidence(general, manifest)
  assert.throws(
    () =>
      verifySettingsErrorEvidence(
        {
          ...general,
          states: general.states.filter((state) => state.id !== 'root-error'),
        },
        manifest.filter((entry) => entry.state !== 'root-error'),
      ),
    /Missing required error state: root-error/,
  )
})

test('legacy captures remain intact and ignored after updating the ignore rules', (t) => {
  const { primary, git } = fixture(t)
  copyFileSync(
    new URL('../.gitignore', import.meta.url),
    join(primary, '.gitignore'),
  )
  git(primary, ['add', '.gitignore'])
  git(primary, [
    '-c',
    'user.name=Capture Test',
    '-c',
    'user.email=capture@example.com',
    '-c',
    'commit.gpgsign=false',
    'commit',
    '--quiet',
    '-m',
    'current ignore rules',
  ])
  for (const legacy of ['screen-captures', '.tmp-task-walkthrough']) {
    mkdirSync(join(primary, legacy))
    writeFileSync(join(primary, legacy, 'evidence.json'), 'legacy evidence')
  }
  const root = screenCaptureOutputRoot((_file, args) => git(primary, args))
  mkdirSync(join(root, 'new-label'), { recursive: true })
  writeFileSync(join(root, 'new-label', 'evidence.json'), 'new evidence')
  assert.equal(
    git(primary, ['status', '--porcelain', '--untracked-files=all']),
    '',
  )
  for (const legacy of ['screen-captures', '.tmp-task-walkthrough']) {
    assert.equal(
      readFileSync(join(primary, legacy, 'evidence.json'), 'utf8'),
      'legacy evidence',
    )
    assert.equal(
      git(primary, ['check-ignore', `${legacy}/evidence.json`]),
      `${legacy}/evidence.json`,
    )
  }
  // Compatibility is restricted to the two old root-level directories.
  mkdirSync(join(primary, 'nested', 'screen-captures'), { recursive: true })
  writeFileSync(
    join(primary, 'nested', 'screen-captures', 'evidence.json'),
    'visible',
  )
  assert.match(
    git(primary, ['status', '--porcelain', '--untracked-files=all']),
    /nested\/screen-captures\/evidence.json/,
  )
})

test('rejects a checkout at the filesystem root', () => {
  assert.throws(
    () =>
      screenCaptureOutputRoot((_file, args) =>
        args.includes('--show-toplevel') ? '/' : '/.git',
      ),
    /filesystem root/,
  )
})

test('preserves an explicitly injected screen capture output root', () => {
  assert.equal(
    screenCaptureOutputDirectory('before', '/tmp/explicit-captures'),
    join('/tmp/explicit-captures', 'before'),
  )
})

test('the sandbox preflight follows the selected sandbox and keeps the pnpm dev default', () => {
  const sandboxScreen = { ready: { selector: '[data-sandbox-state="ready"]' } }
  const selected = { SCREEN_CAPTURE_SANDBOX_URL: 'https://localhost:41102' }
  assert.equal(
    localSandboxOrigin('https://localhost:41101', selected),
    'https://localhost:41102',
  )
  assert.equal(
    needsLocalSandbox('https://localhost:41101', [sandboxScreen], selected),
    true,
  )
  assert.equal(
    localSandboxOrigin('https://localhost:5173', {}),
    'https://localhost:5174',
  )
  assert.equal(localSandboxOrigin('https://localhost:41101', {}), null)
  assert.equal(
    needsLocalSandbox('https://localhost:41101', [sandboxScreen], {}),
    false,
  )
})

test('reads the retry budget from the environment', () => {
  assert.equal(captureRetries({}), 2)
  assert.equal(captureRetries({ SCREEN_CAPTURE_RETRIES: '0' }), 0)
  assert.equal(captureRetries({ SCREEN_CAPTURE_RETRIES: '3' }), 3)
  assert.throws(() => captureRetries({ SCREEN_CAPTURE_RETRIES: '-1' }))
  assert.throws(() => captureRetries({ SCREEN_CAPTURE_RETRIES: 'many' }))
  assert.throws(() => captureRetries({ SCREEN_CAPTURE_RETRIES: '1e3' }))
  assert.throws(() => captureRetries({ SCREEN_CAPTURE_RETRIES: '11' }))
})

test('retries only readiness timeouts within the budget', () => {
  const timeout = { kind: 'readiness_timeout' }
  assert.equal(shouldRetryCapture(timeout, 0, 2, true), true)
  assert.equal(shouldRetryCapture(timeout, 1, 2, true), true)
  assert.equal(shouldRetryCapture(timeout, 2, 2, true), false)
  assert.equal(shouldRetryCapture(timeout, 0, 0, true), false)
  assert.equal(shouldRetryCapture({ kind: 'navigation' }, 0, 2, true), false)
  // A readiness timeout after an interaction is the interaction's fault.
  assert.equal(shouldRetryCapture(timeout, 0, 2, false), false)
})

test('rejects output roots overlapping a registered worktree before removal or creation', async (t) => {
  const { base, primary, git } = fixture(t)
  mkdirSync(join(primary, 'docs'))
  writeFileSync(join(primary, 'docs', 'tracked.txt'), 'preserve')
  git(primary, ['add', 'docs'])
  git(primary, [
    '-c',
    'user.name=Capture Test',
    '-c',
    'user.email=capture@example.com',
    '-c',
    'commit.gpgsign=false',
    'commit',
    '--quiet',
    '-m',
    'tracked fixture',
  ])
  const run = (_file, args) => git(primary, args)
  const root = screenCaptureOutputRoot(run)
  assert.doesNotThrow(() => assertSafeCaptureOutput([root], run))
  // Register the collision after resolving/preflighting the deterministic root.
  git(primary, ['worktree', 'add', '--quiet', '--detach', root])
  const alias = join(base, 'alias')
  symlinkSync(root, alias)
  for (const candidate of [
    root,
    dirname(root),
    join(root, 'docs'),
    alias,
    primary,
  ]) {
    const target = join(candidate, 'docs')
    await assert.rejects(
      removeCaptureOutput(candidate, target, run),
      /overlaps a registered worktree/,
    )
    await assert.rejects(
      createCaptureOutput(candidate, join(candidate, 'new-output'), run),
      /overlaps a registered worktree/,
    )
  }
  // A cleanup target can independently alias a worktree under a safe root.
  const safeRoot = join(base, 'safe-output')
  mkdirSync(safeRoot)
  const cleanupAlias = join(safeRoot, 'docs')
  symlinkSync(root, cleanupAlias)
  await assert.rejects(
    removeCaptureOutput(safeRoot, cleanupAlias, run),
    /overlaps a registered worktree/,
  )
  await assert.rejects(
    createCaptureOutput(safeRoot, cleanupAlias, run),
    /overlaps a registered worktree/,
  )
  assert.equal(
    readFileSync(join(root, 'docs', 'tracked.txt'), 'utf8'),
    'preserve',
  )
  assert.equal(git(root, ['status', '--porcelain']), '')
  assert.equal(git(primary, ['status', '--porcelain']), '')
  // Explicit external injection and label-scoped replacement still work.
  await createCaptureOutput(safeRoot, join(safeRoot, 'before'), run)
  writeFileSync(join(safeRoot, 'before', 'keep.txt'), 'keep')
  await createCaptureOutput(safeRoot, join(safeRoot, 'after'), run)
  await removeCaptureOutput(safeRoot, join(safeRoot, 'after'), run)
  assert.equal(
    readFileSync(join(safeRoot, 'before', 'keep.txt'), 'utf8'),
    'keep',
  )
})

function cropDirectory(t) {
  const outDir = mkdtempSync(join(tmpdir(), 'screen-crops-'))
  t.after(() => rmSync(outDir, { recursive: true, force: true }))
  return outDir
}

function sectionPage({ height = 900, targets = {}, failFull = false } = {}) {
  const shots = []
  const queries = []
  return {
    shots,
    queries,
    viewportSize: () => ({ width: 1440, height }),
    evaluate: (fn) => {
      // Exercise the actual browser callback with a scrolled viewport.
      const previous = globalThis.window
      globalThis.window = {
        scrollX: 5,
        scrollY: 1200,
        innerHeight: height,
        document: { documentElement: { scrollHeight: 8000 } },
      }
      try {
        return fn()
      } finally {
        if (previous === undefined) delete globalThis.window
        else globalThis.window = previous
      }
    },
    locator: (selector) => {
      queries.push(selector)
      const target = targets[selector] ?? {}
      return {
        count: () => target.count ?? 1,
        isVisible: () => target.visible ?? true,
        boundingBox: () =>
          target.box ?? { x: 20, y: 3800, width: 320, height: 4000 },
      }
    },
    screenshot: (options) => {
      shots.push(options)
      if (failFull && !options.clip) throw new Error('full-page failed')
    },
  }
}

function captureEntry(viewport = 'desktop', theme = 'light', locale = 'en') {
  return {
    status: 'success',
    screen: 'guides-cli',
    state: 'default',
    viewport,
    theme,
    locale,
    file: fileName(
      { id: 'guides-cli' },
      { id: 'default' },
      viewport,
      theme,
      locale,
    ),
    url: `https://localhost/${locale}/guides/cli?theme=${theme}`,
    head: 'a'.repeat(40),
    attempts: 2,
  }
}

test('captures full-page then four bounded crops for all eight guide combinations', async (t) => {
  const outDir = cropDirectory(t)
  const sections = ['introduction', 'basics', 'commands', 'recovery'].map(
    (id) => ({ id, selector: `#${id}` }),
  )
  const manifest = []
  for (const [viewport, height] of [
    ['desktop', 900],
    ['mobile', 844],
  ])
    for (const theme of ['light', 'dark'])
      for (const locale of ['en', 'ja']) {
        const page = sectionPage({
          height,
          targets: {
            '#introduction': {
              box: { x: 20, y: -1000, width: 320, height: 400 },
            },
          },
        })
        let audits = 0
        const gapAudit = { result: 'passed', findings: [] }
        const entry = captureEntry(viewport, theme, locale)
        const entries = await captureScreenImages({
          page,
          entry,
          sections,
          outDir,
          afterFullCapture: () => {
            audits++
            return { gapAudit }
          },
        })
        assert.equal(audits, 1)
        assert.deepEqual(entries[0], { ...entry, gapAudit })
        assert.deepEqual(page.shots[0], {
          path: join(outDir, entry.file),
          style: fullPageCaptureStyle,
          fullPage: true,
        })
        assert.deepEqual(
          page.queries,
          sections.map((section) => section.selector),
        )
        assert.equal(page.shots.length, 5)
        for (const [index, section] of sections.entries()) {
          const file = `guides-cli--default--${viewport}--${theme}--${locale}--section-${section.id}.png`
          assert.deepEqual(entries[index + 1], {
            ...entry,
            gapAudit,
            file,
            section: section.id,
          })
          assert.deepEqual(page.shots[index + 1], {
            path: join(outDir, file),
            style: fullPageCaptureStyle,
            fullPage: true,
            clip: {
              x: 25,
              y: index === 0 ? 200 : 5000,
              width: 320,
              height: index === 0 ? 400 : height * 2,
            },
          })
        }
        manifest.push(...entries)
      }
  assert.equal(
    manifest.filter((entry) => entry.section === undefined).length,
    8,
  )
  assert.equal(
    manifest.filter((entry) => entry.section !== undefined).length,
    32,
  )
})

for (const [reason, target] of [
  ['found 0', { count: 0 }],
  ['found 2', { count: 2 }],
  ['invisible', { visible: false }],
  ['positive-area', { box: { x: 0, y: 0, width: 0, height: 20 } }],
]) {
  test(`section failure (${reason}) preserves full-page and subsequent crops without retry`, async (t) => {
    const outDir = cropDirectory(t)
    const page = sectionPage({ targets: { '#missing': target } })
    const messages = []
    const entries = await captureScreenImages({
      page,
      entry: captureEntry(),
      outDir,
      sections: [
        { id: 'missing', selector: '#missing' },
        { id: 'recovery', selector: '#recovery' },
      ],
      reportFailure: (message) => messages.push(message),
    })
    assert.deepEqual(
      entries.map((entry) => [entry.section, entry.status]),
      [
        [undefined, 'success'],
        ['missing', 'failed'],
        ['recovery', 'success'],
      ],
    )
    assert.equal(entries[1].file, undefined)
    assert.equal(entries[1].failure.selector, '#missing')
    assert.equal(entries[1].failure.condition, 'section: missing')
    assert.match(entries[1].failure.message, new RegExp(reason))
    assert.match(
      messages[0],
      /guides-cli\/default\/desktop\/light\/en\/section-missing/,
    )
    assert.equal(shouldRetryCapture(entries[1].failure, 0, 2, true), false)
    assert.equal(page.shots.length, 2)
  })
}

test('omitted and empty sections preserve full-page calls and manifest shape', async (t) => {
  const outDir = cropDirectory(t)
  for (const sections of [undefined, []]) {
    const page = sectionPage()
    const entry = captureEntry()
    assert.deepEqual(
      await captureScreenImages({
        page,
        entry,
        sections,
        outDir,
      }),
      [entry],
    )
    assert.deepEqual(page.queries, [])
    assert.deepEqual(page.shots, [
      {
        path: join(outDir, entry.file),
        style: fullPageCaptureStyle,
        fullPage: true,
      },
    ])
  }
})

test('full-page failure never attempts sections', async (t) => {
  const outDir = cropDirectory(t)
  const page = sectionPage({ failFull: true })
  await assert.rejects(
    captureScreenImages({
      page,
      entry: captureEntry(),
      outDir,
      sections: [{ id: 'intro', selector: '#intro' }],
    }),
    /full-page failed/,
  )
  assert.deepEqual(page.queries, [])
  assert.equal(page.shots.length, 1)
})

test('review output preserves ordered section failures, stamps HEAD and fails after writing', async (t) => {
  const outDir = mkdtempSync(join(tmpdir(), 'section-output-'))
  t.after(() => rmSync(outDir, { recursive: true, force: true }))
  const entries = await captureScreenImages({
    page: sectionPage({ targets: { '#missing': { count: 0 } } }),
    entry: { ...captureEntry(), order: 0 },
    outDir,
    sections: [
      { id: 'missing', selector: '#missing' },
      { id: 'recovery', selector: '#recovery' },
    ],
    reportFailure: () => {},
  })
  const later = { ...captureEntry('mobile'), order: 1 }
  const head = 'b'.repeat(40)
  await assert.rejects(
    writeCaptureReviewOutput({
      manifest: [later, ...entries],
      head,
      selected: [{ id: 'guides-cli' }],
      outDir,
      label: 'sections',
    }),
    /1 capture\(s\) failed/,
  )
  const manifest = JSON.parse(
    readFileSync(join(outDir, 'manifest.json'), 'utf8'),
  )
  assert.deepEqual(
    manifest.map((entry) => [entry.viewport, entry.section, entry.status]),
    [
      ['desktop', undefined, 'success'],
      ['desktop', 'missing', 'failed'],
      ['desktop', 'recovery', 'success'],
      ['mobile', undefined, 'success'],
    ],
  )
  for (const entry of manifest) {
    assert.equal(entry.head, head)
    assert.equal(Object.hasOwn(entry, 'order'), false)
  }
  const html = readFileSync(join(outDir, 'index.html'), 'utf8')
  assert.match(html, /section: missing · failed: section_capture_failure/)
  assert.match(html, /section: recovery/)
  assert.ok(html.includes(entries[0].file))
  assert.ok(html.includes(entries[2].file))
})

for (const [status, expectedStatus, accepted] of [
  [200, undefined, true],
  [204, undefined, true],
  [410, undefined, false],
  [404, undefined, false],
  [500, undefined, false],
  [410, 410, true],
  [200, 410, false],
  [404, 410, false],
  [500, 410, false],
  [null, 410, false],
]) {
  test(`capture navigation status ${status}, expected ${expectedStatus}: ${accepted}`, async () => {
    const page = {
      goto: (url, options) => {
        assert.equal(url, 'https://example.com/a/s1')
        assert.deepEqual(options, { waitUntil: 'networkidle' })
        return status === null
          ? null
          : {
              status: () => status,
              ok: () => status >= 200 && status < 300,
            }
      },
    }
    const navigation = navigateForCapture(
      page,
      'https://example.com/a/s1',
      expectedStatus,
    )
    if (accepted) await navigation
    else await assert.rejects(navigation, /navigation failed: HTTP/)
  })
}

test('capture navigation errors remain failures with an expected status', async () => {
  await assert.rejects(
    navigateForCapture(
      {
        goto: () => {
          throw new Error('connection refused')
        },
      },
      'https://example.com/a/s1',
      410,
    ),
    /navigation failed: connection refused/,
  )
})

test('capture action matching isolates route, method, origin and JSON/form intent', async () => {
  const { matchesCaptureAction } = await import('./screen-capture.mjs')
  const actionFixture = {
    route: '/settings/bots',
    method: 'POST',
    intent: 'stop',
  }
  for (const [path, method, contentType, body, expected] of [
    [
      '/settings/bots.data?_routes=routes%2Fsettings%2Fbots',
      'POST',
      'application/json',
      '{"intent":"stop"}',
      true,
    ],
    [
      '/settings/bots',
      'POST',
      'application/x-www-form-urlencoded',
      'intent=stop',
      true,
    ],
    ...['', 'not json', 'null'].map((invalidBody) => [
      '/settings/bots',
      'POST',
      'application/json',
      invalidBody,
      false,
    ]),
    ['/settings/bots', 'GET', 'application/json', '{"intent":"stop"}', false],
    [
      '/settings/bots',
      'POST',
      'application/json',
      '{"intent":"reissue"}',
      false,
    ],
    [
      '/settings/bots-extra.data',
      'POST',
      'application/json',
      '{"intent":"stop"}',
      false,
    ],
  ]) {
    const request = {
      url: () => 'https://example.test' + path,
      method: () => method,
      headers: () => ({ 'content-type': contentType }),
      postData: () => body,
    }
    assert.equal(
      await matchesCaptureAction(
        request,
        actionFixture,
        'https://example.test',
      ),
      expected,
    )
    assert.equal(
      await matchesCaptureAction(
        request,
        actionFixture,
        'https://other.example.test',
      ),
      false,
    )
  }
  const form = new FormData()
  form.set('intent', 'stop')
  const encoded = new Response(form)
  const body = await encoded.text()
  assert.equal(
    await matchesCaptureAction(
      {
        url: () => 'https://example.test/settings/bots.data',
        method: () => 'POST',
        headers: () => ({
          'content-type': encoded.headers.get('content-type'),
        }),
        postData: () => body,
      },
      actionFixture,
      'https://example.test',
    ),
    true,
  )
})

test('capture inline failure is router-decodable and matched actions are never forwarded', async () => {
  const requireWeb = createRequire(
    new URL('../apps/web/package.json', import.meta.url),
  )
  const { UNSAFE_decodeViaTurboStream } = requireWeb('react-router')
  const { installCaptureActionResponse } = await import('./screen-capture.mjs')
  let handler
  let fulfilled
  let forwarded = 0
  let removed = false
  const actionFixture = await installCaptureActionResponse(
    {
      route: (_pattern, next) => {
        handler = next
      },
      unroute: () => {
        removed = true
      },
    },
    {
      route: '/settings/external-access',
      method: 'POST',
      intent: 'update-external-access',
      status: 403,
      data: { ok: false, code: 'forbidden', intent: 'update-external-access' },
    },
    'https://example.test',
  )
  await assert.rejects(
    actionFixture.waitForMatch(0),
    /expected one request, received 0/,
  )
  const route = {
    request: () => ({
      url: () => 'https://example.test/settings/external-access.data',
      method: () => 'POST',
      headers: () => ({ 'content-type': 'application/x-www-form-urlencoded' }),
      postData: () => 'intent=update-external-access',
    }),
    fulfill: (response) => {
      fulfilled = response
    },
    fallback: () => {
      forwarded++
    },
  }
  await handler(route)
  await actionFixture.waitForMatch()
  assert.equal(forwarded, 0)
  assert.equal(fulfilled.status, 403)
  assert.equal(fulfilled.headers['X-Remix-Response'], 'yes')
  assert.equal(fulfilled.contentType, 'text/x-script')
  const decoded = await UNSAFE_decodeViaTurboStream(
    new Response(fulfilled.body).body,
    globalThis,
  )
  assert.deepEqual(decoded.value, {
    data: { ok: false, code: 'forbidden', intent: 'update-external-access' },
  })
  await handler(route)
  await assert.rejects(
    actionFixture.assertMatched(),
    /expected one request, received 2/,
  )
  await actionFixture.cleanup()
  assert.equal(removed, true)
})

for (const duplicate of [false, true]) {
  test(`capture waits for multipart matching and checks requests received during the screenshot (duplicate=${duplicate})`, async (t) => {
    const { installCaptureActionResponse } =
      await import('./screen-capture.mjs')
    const events = []
    let handler
    const actionFixture = await installCaptureActionResponse(
      {
        route: (_pattern, next) => {
          handler = next
        },
        unroute: () => {
          events.push('removed')
        },
      },
      {
        route: '/settings/bots',
        method: 'POST',
        intent: 'stop',
        pending: true,
      },
      'https://example.test',
    )
    const form = new FormData()
    form.set('intent', 'stop')
    const encoded = new Response(form)
    const body = await encoded.text()
    const readForm = Response.prototype.formData
    t.mock.method(Response.prototype, 'formData', async function () {
      // Let readiness or the screenshot finish before the body can be matched.
      await new Promise((nextTurn) => setImmediate(nextTurn))
      const data = await readForm.call(this)
      events.push('read')
      return data
    })
    const route = {
      request: () => ({
        url: () => 'https://example.test/settings/bots.data',
        method: () => 'POST',
        headers: () => ({
          'content-type': encoded.headers.get('content-type'),
        }),
        postData: () => body,
      }),
      abort: () => {
        events.push('aborted')
      },
      fallback: () => {
        throw new Error('Matched action forwarded')
      },
    }
    const requests = [handler(route)]
    const capture = captureScreenImages({
      ready: { selector: '#busy' },
      actionResponse: actionFixture,
      page: {
        evaluate: () => false,
        locator: () => ({ waitFor: () => events.push('ready') }),
        screenshot: () => {
          assert.deepEqual(events, ['ready', 'read'])
          events.push('screenshot')
          if (duplicate) requests.push(handler(route))
        },
      },
      outDir: '/tmp',
      sections: [],
      entry: { file: 'held.png' },
    })
    try {
      if (duplicate)
        await assert.rejects(capture, /expected one request, received 2/)
      else await capture
    } finally {
      await actionFixture.cleanup()
      await Promise.all(requests)
    }
    assert.deepEqual(events, [
      'ready',
      'read',
      'screenshot',
      ...(duplicate ? ['read', 'aborted'] : []),
      'aborted',
      'removed',
    ])
  })
}

test('expected-error screenshot requires the exact status, marker and readiness together', async () => {
  const state = {
    id: 'forbidden',
    expectedStatus: 403,
    expectedError: 'settings-error-boundary',
    setup: { ready: { selector: 'a', description: 'Settings recovery link' } },
  }
  for (const [status, marker, ready, failure] of [
    [403, 'settings-error-boundary', 'disappears', /ready condition was lost/],
    [403, 'settings-error-boundary', true, null],
    [200, 'settings-error-boundary', true, /navigation failed: HTTP 200/],
    [403, 'route-error-boundary', true, /Expected one visible boundary/],
    [
      403,
      'settings-error-boundary',
      false,
      /ready condition was not met: Settings recovery link/,
    ],
  ]) {
    const page = sectionPage()
    let visible = Boolean(ready)
    page.goto = () => ({ status: () => status, ok: () => status === 200 })
    page.locator = () => ({
      isVisible: () => visible,
      waitFor: () => {
        if (!ready) throw new Error('not ready')
      },
      count: () => 1,
      first: () => ({ getAttribute: () => marker, isVisible: () => true }),
    })
    const capture = async () => {
      await navigateForCapture(
        page,
        'https://app.example/settings/general',
        state.expectedStatus,
      )
      await captureScreenImages({
        page,
        entry: captureEntry(),
        outDir: '/tmp',
        ready: state.setup.ready,
        expectedError: state.expectedError,
        beforeFullCapture: () => {
          if (ready === 'disappears') visible = false
          return assertCaptureSurface(page, 'settings-general', state)
        },
      })
    }
    if (failure) await assert.rejects(capture, failure)
    else await capture()
    assert.equal(page.shots.length, failure ? 0 : 1)
  }
})

test('only the root recovery logo may link outside the consent banner', (t) => {
  const { Window } = createRequire(
    new URL('../apps/web/package.json', import.meta.url),
  )('happy-dom')
  const window = new Window()
  t.after(() => window.happyDOM.close())
  const doc = window.document
  doc.body.innerHTML =
    '<main data-screen-capture-error="route-error-boundary"><a href="/">Home</a></main><aside role="region" data-analytics-consent-banner><a href="/privacy">Privacy</a></aside><section role="region"></section>'
  const logo = doc.querySelector('main a')
  const bounds = { x: 16, y: 16, width: 40, height: 20 }
  t.mock.method(logo, 'getBoundingClientRect', () => bounds)
  assert.equal(rootErrorLogoAtTopLeft(doc), true)
  bounds.x = 160
  assert.equal(rootErrorLogoAtTopLeft(doc), false)
  bounds.x = 16
  bounds.y = 160
  assert.equal(rootErrorLogoAtTopLeft(doc), false)
  bounds.y = 16
  const region = doc.querySelector('section')
  region.innerHTML = '<a href="/extra">Extra</a>'
  assert.equal(rootErrorLogoAtTopLeft(doc), false)
  region.replaceChildren(logo)
  assert.equal(rootErrorLogoAtTopLeft(doc), false)
})

test('an uncaught page error fails the capture with its first message', async () => {
  const { assertNoPageError, captureFailure } =
    await import('./screen-capture.mjs')
  assert.deepEqual(assertNoPageError([]), [])
  assert.deepEqual(
    assertNoPageError([
      new Error(
        "Hydration failed because the server rendered text didn't match the client.\nmore",
      ),
    ]),
    [
      "the page recovered from an error: Hydration failed because the server rendered text didn't match the client.",
    ],
  )
  let thrown
  try {
    assertNoPageError([
      new TypeError(
        'Failed to fetch dynamically imported module: https://localhost/app/entry.client.tsx\n    at stack',
      ),
      new Error('second'),
    ])
  } catch (error) {
    thrown = error
  }
  const failure = captureFailure(thrown)
  assert.equal(failure.kind, 'page_error')
  assert.equal(
    failure.message,
    'the page failed to run: Failed to fetch dynamically imported module: https://localhost/app/entry.client.tsx',
  )
  assert.equal(failure.count, 2)
  // A page that never hydrated is reported, not retried into a pass.
  assert.equal(shouldRetryCapture(failure, 0, 2, true), false)
})

test('a failed or rejected script of the page itself counts as a page error', async () => {
  const { watchPageErrors, assertNoPageError, captureFailure } =
    await import('./screen-capture.mjs')
  const listeners = {}
  const mainFrame = { url: () => 'https://viewer.test/a/share' }
  const otherFrame = { url: () => 'https://sandbox.test/' }
  const page = {
    on: (event, listener) => {
      listeners[event] = listener
    },
    mainFrame: () => mainFrame,
  }
  const pageErrors = []
  watchPageErrors(page, pageErrors)
  const request = (
    url,
    { resourceType = 'script', frame = mainFrame, errorText } = {},
  ) => ({
    url: () => url,
    resourceType: () => resourceType,
    frame: () => frame,
    failure: () => ({ errorText }),
  })
  const respond = (status, req) =>
    listeners.response({ status: () => status, request: () => req })
  respond(200, request('https://viewer.test/app/root.tsx'))
  respond(
    504,
    request('https://viewer.test/logo.png', { resourceType: 'image' }),
  )
  respond(404, request('https://sandbox.test/app.js', { frame: otherFrame }))
  respond(404, request('https://cdn.example/other.js'))
  listeners.requestfailed(
    request('https://viewer.test/app/route.tsx', {
      errorText: 'net::ERR_ABORTED',
    }),
  )
  assert.deepEqual(pageErrors, [])
  respond(
    504,
    request(
      'https://viewer.test/node_modules/.vite/deps/react-dom_client.js?v=1',
    ),
  )
  listeners.requestfailed(
    request('https://viewer.test/app/entry.client.tsx', {
      errorText: 'net::ERR_CONNECTION_RESET',
    }),
  )
  assert.equal(pageErrors.length, 2)
  let thrown
  try {
    assertNoPageError(pageErrors)
  } catch (error) {
    thrown = error
  }
  assert.deepEqual(
    [captureFailure(thrown).kind, captureFailure(thrown).message],
    [
      'page_error',
      'the page failed to run: script /node_modules/.vite/deps/react-dom_client.js returned 504',
    ],
  )
})
