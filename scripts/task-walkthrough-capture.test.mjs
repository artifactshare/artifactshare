import assert from 'node:assert/strict'
import { resolve as resolvePath } from 'node:path'
import test from 'node:test'
import { runInNewContext } from 'node:vm'
import {
  captureStep,
  clickSettleMilliseconds,
  cleanupCliArtifacts,
  combineWalkthroughAndCleanupErrors,
  isExpectedMissingTargetFailure,
  isSheetVisible,
  linkViewerUrlForCapture,
  parseCliJsonOutput,
  parseWalkthroughArgs,
  redactEvidenceText,
  walkthroughCliEnvironment,
  redactEvidenceUrl,
  recordCaptureRevision,
  requestOriginPhase,
  shouldWaitForViewerReady,
  missingCliRecovery,
  walkthroughCliEntry,
  walkthroughSandboxOrigin,
} from './task-walkthrough-capture.mjs'
import { setImmediate as flush } from 'node:timers/promises'
import { fullPageCaptureStyle } from './screen-capture.mjs'
import { championLoopTaskIds, taskWalkthroughs } from './task-walkthroughs.mjs'

test('selects the champion loop in its canonical order', () => {
  assert.deepEqual(
    parseWalkthroughArgs(['--champion-loop', '--label', 'audit']),
    {
      selected: championLoopTaskIds,
      label: 'audit',
    },
  )
})

test('rejects ambiguous, missing, and unknown selections', () => {
  assert.throws(() => parseWalkthroughArgs([]), /Usage:/)
  assert.throws(
    () =>
      parseWalkthroughArgs([
        '--champion-loop',
        '--task',
        championLoopTaskIds[0],
      ]),
    /Usage:/,
  )
  assert.throws(
    () => parseWalkthroughArgs(['--task', 'missing']),
    /Unknown walkthrough task/,
  )
})

test('aggregates revision failures and always closes preflight fetches', async () => {
  const failures = ['cli: missing build']
  let closed = false
  await recordCaptureRevision(failures, 'https://localhost', 'a'.repeat(40), {
    assertServerHead: () => Promise.reject(new Error('server mismatch')),
    close: () => {
      closed = true
      return Promise.resolve()
    },
  })
  assert.deepEqual(failures, [
    'cli: missing build',
    'revision: server mismatch',
  ])
  assert.equal(closed, true)
})

test('captures pending navigation and clicks before their ready delay', () => {
  assert.equal(shouldWaitForViewerReady('/a/example', 'networkidle'), true)
  assert.equal(
    shouldWaitForViewerReady('/a/example', 'domcontentloaded'),
    false,
  )
  assert.equal(clickSettleMilliseconds({ captureDuringNavigation: true }), 0)
  assert.equal(clickSettleMilliseconds({}), 500)
})

test('preflights the selected sandbox, or 5174 for an external server', () => {
  assert.equal(
    walkthroughSandboxOrigin('https://localhost:41101', {
      SCREEN_CAPTURE_SANDBOX_URL: 'https://localhost:41102/',
    }),
    'https://localhost:41102',
  )
  assert.equal(
    walkthroughSandboxOrigin('https://localhost:5173', {}),
    'https://localhost:5174',
  )
  assert.equal(
    walkthroughSandboxOrigin('https://localhost:41101', {}),
    'https://localhost:5174',
  )
})

test('runs the CLI build the local capture names, or the checkout build', () => {
  assert.equal(
    walkthroughCliEntry({ WALKTHROUGH_CLI_ENTRY: '/run/cli/dist/index.js' }),
    '/run/cli/dist/index.js',
  )
  assert.equal(
    walkthroughCliEntry({}),
    resolvePath('packages/cli/dist/index.js'),
  )
})

test('a missing CLI build names the step that builds it', () => {
  const runtime = missingCliRecovery({
    WALKTHROUGH_CLI_ENTRY: '/run/cli/dist/index.js',
  })
  assert.match(runtime, /\/run\/cli\/dist\/index\.js is missing/)
  assert.match(runtime, /local capture's CLI build/)
  assert.match(runtime, /pnpm walkthroughs:capture:local/)
  assert.doesNotMatch(runtime, /--filter @artifactshare\/cli build/)
  assert.match(
    missingCliRecovery({}),
    /dist\/index\.js is missing; run pnpm --filter @artifactshare\/cli build/,
  )
})

test('derives the recipient link URL used by walkthrough clipboard checks', () => {
  assert.equal(
    linkViewerUrlForCapture('https://localhost:5173', 'abc123def4'),
    'https://abc123def4.localhost:5173/',
  )
  assert.equal(
    linkViewerUrlForCapture('https://localhost:41101', 'abc123def4'),
    'https://abc123def4.localhost:41101/',
  )
  assert.equal(
    linkViewerUrlForCapture('https://artifactshare.com', 'abc123def4'),
    'https://abc123def4.artifactshare.link/',
  )
})

test('reports sheet visibility from the rendered page', async () => {
  const page = {
    locator: () => ({
      count: () => Promise.resolve(1),
      isVisible: () => Promise.resolve(false),
    }),
  }
  assert.equal(await isSheetVisible(page), false)
})

test('accepts only the intended missing-target CLI failure', () => {
  assert.equal(
    isExpectedMissingTargetFailure('cliUpdateMissing', {
      ok: false,
      error: { code: 'target_not_found' },
    }),
    true,
  )
  assert.equal(
    isExpectedMissingTargetFailure('cliUpdateMissing', {
      ok: false,
      error: { code: 'service_unavailable' },
    }),
    false,
  )
  assert.equal(
    isExpectedMissingTargetFailure('cliUpdate', {
      ok: false,
      error: { code: 'target_not_found' },
    }),
    false,
  )
})

test('parses CLI JSON after a Node TLS warning', () => {
  assert.deepEqual(
    parseCliJsonOutput(
      '(node:123) Warning: Setting NODE_TLS_REJECT_UNAUTHORIZED to 0\n' +
        '{"ok":false,"error":{"code":"target_not_found"}}\n',
      '',
    ),
    { ok: false, error: { code: 'target_not_found' } },
  )
})

test('keeps late request failures with their originating phase', () => {
  const request = {}
  const requestPhases = new WeakMap([[request, 'pending']])
  assert.equal(requestOriginPhase(requestPhases, request, 'success'), 'pending')
  assert.equal(requestOriginPhase(requestPhases, {}, 'success'), 'success')
})

test('redacts signed sandbox tokens from retained evidence URLs', () => {
  assert.equal(
    redactEvidenceUrl(
      'https://artifact.usercontent.localhost/file.html?__as_token=secret',
    ),
    'https://artifact.usercontent.localhost/file.html?__as_token=%5Bredacted%5D',
  )
  assert.equal(redactEvidenceUrl('not a URL'), 'not a URL')
  assert.equal(
    redactEvidenceText(
      'Loading https://artifact.usercontent.localhost/file.html?__as_token=secret&mode=html',
    ),
    'Loading https://artifact.usercontent.localhost/file.html?__as_token=[redacted]&mode=html',
  )
})

test('preserves the walkthrough failure when cleanup also fails', () => {
  const walkthroughError = new Error('navigation failed')
  const cleanupError = new Error('delete failed')
  const combined = combineWalkthroughAndCleanupErrors(
    walkthroughError,
    cleanupError,
  )
  assert.equal(combined.cause, walkthroughError)
  assert.deepEqual(combined.errors, [walkthroughError, cleanupError])
  assert.match(combined.message, /navigation failed.*delete failed/)
})

test('attempts every CLI artifact cleanup after an earlier deletion fails', async () => {
  const attempted = []
  const state = { cliArtifactId: null }
  await assert.rejects(
    cleanupCliArtifacts({
      artifactIds: ['first', 'second'],
      state,
      deleteArtifact: (artifactId) => {
        attempted.push(artifactId)
        return artifactId === 'first'
          ? Promise.reject(new Error('first failed'))
          : Promise.resolve()
      },
    }),
    /first failed/,
  )
  assert.deepEqual(attempted, ['first', 'second'])
  assert.equal(state.cliArtifactId, null)
})

test('walkthrough CLI runs as a fresh user inside the capture directory', () => {
  const cli = walkthroughCliEnvironment({
    tempDir: '/capture/.tmp-task-walkthrough',
    token: 'session',
    env: {
      PATH: '/usr/bin',
      HOME: '/Users/maintainer',
      XDG_CONFIG_HOME: '/Users/maintainer/.config',
      ARTIFACTSHARE_CONFIG_HOME: '/Users/maintainer/.config/artifactshare',
      ARTIFACTSHARE_PROFILE: 'work',
    },
  })
  assert.equal(cli.cwd, '/capture/.tmp-task-walkthrough/cli-cwd')
  assert.deepEqual(cli.env, {
    PATH: '/usr/bin',
    HOME: '/capture/.tmp-task-walkthrough/cli-home',
    USERPROFILE: '/capture/.tmp-task-walkthrough/cli-home',
    ARTIFACTSHARE_CONFIG_HOME:
      '/capture/.tmp-task-walkthrough/cli-home/.config/artifactshare',
    ARTIFACTSHARE_DISABLE_NATIVE_TOKEN_STORE: '1',
    ARTIFACTSHARE_TOKEN: 'session',
    NODE_TLS_REJECT_UNAUTHORIZED: '0',
  })
})

function animatedPage(states) {
  let time = 0
  const events = []
  const document = {
    querySelectorAll(selector) {
      assert.equal(
        selector,
        '[data-slot="sheet-content"], [data-slot="sheet-overlay"]',
      )
      return states(time).map((animations) => ({
        getAnimations(options) {
          assert.equal(options.subtree, true)
          return animations.map((animation) =>
            typeof animation === 'string'
              ? { playState: animation }
              : animation,
          )
        },
      }))
    },
  }
  const locator = {
    waitFor: () => Promise.resolve(),
    click: () => {
      events.push('click')
    },
    count: () => Promise.resolve(1),
    isVisible: () => Promise.resolve(true),
    first() {
      return this
    },
  }
  const page = {
    evaluate: (fn) => {
      events.push('inspect')
      return runInNewContext(`(${fn.toString()})()`, {
        document,
        navigator: {},
      })
    },
    locator: () => locator,
    url: () => 'https://localhost/a/example',
    goto: () => Promise.resolve({ ok: () => true }),
    route: () => Promise.resolve(),
    waitForTimeout: () => {
      events.push('action-delay')
    },
    waitForLoadState: () => {
      events.push('load')
      return Promise.resolve()
    },
    screenshot: () => {
      events.push(`screenshot:${time}`)
    },
  }
  return {
    page,
    events,
    animationTiming: {
      now: () => time,
      sleep: (ms) => {
        time += ms
        events.push('poll')
      },
    },
  }
}

test('phase capture waits for content and overlay subtree animations before PNG', async () => {
  for (const states of [
    (time) => [[time < 100 ? 'running' : 'finished'], []],
    (time) => [['finished'], [time < 150 ? 'running' : 'finished']],
    (time) => (time < 100 ? [['paused']] : []),
    (time) => [time < 100 ? ['running'] : []],
  ]) {
    const fake = animatedPage(states)
    const evidence = await captureStep({
      ...fake,
      action: { kind: 'inspect', selector: 'main' },
      screenshot: {},
    })
    assert.equal(evidence.sheetAnimationWait.status, 'completed')
    assert.ok(evidence.sheetAnimationWait.elapsedMs >= 100)
    assert.equal(fake.events.at(-2), 'inspect')
    assert.match(fake.events.at(-1), /^screenshot:/)
  }
})

test('absent, empty, and finished animations capture immediately', async () => {
  for (const states of [[], [[], []], [['finished'], ['finished']]]) {
    const fake = animatedPage(() => states)
    const evidence = await captureStep({
      ...fake,
      action: { kind: 'inspect', selector: 'main' },
      screenshot: {},
    })
    assert.deepEqual(evidence.sheetAnimationWait, {
      status: 'completed',
      elapsedMs: 0,
      timeoutMs: 2000,
    })
    assert.deepEqual(fake.events, ['inspect', 'screenshot:0'])
  }
})

test('content and overlay share one bound and timeout still permits PNG', async () => {
  const fake = animatedPage(() => [['running'], ['paused']])
  const evidence = await captureStep({
    ...fake,
    action: { kind: 'inspect', selector: 'main' },
    screenshot: {},
  })
  assert.deepEqual(evidence.sheetAnimationWait, {
    status: 'timed-out',
    elapsedMs: 2000,
    timeoutMs: 2000,
  })
  assert.equal(fake.events.at(-1), 'screenshot:2000')
})

test('sheet opening clicks settle immediately and retain separate phase diagnostics', async () => {
  for (const kind of [
    'gotoArtifactAndClick',
    'gotoCliArtifactAndClick',
    'click',
    'clickWithClipboardFailure',
  ]) {
    const fake = animatedPage((time) => [
      [time <= 2000 ? 'running' : 'finished'],
      [],
    ])
    const evidence = await captureStep({
      ...fake,
      action: { kind, selector: 'button', captureDuringNavigation: true },
      screenshot: {},
      baseUrl: 'https://localhost',
      state: { artifactIndex: 0, cliArtifactId: 'example' },
      session: { workspaceId: 'workspace', userId: 'user' },
    })
    const click = fake.events.indexOf('click')
    assert.equal(fake.events[click + 1], 'inspect')
    assert.equal(evidence.clicked.sheetAnimationWait.status, 'timed-out')
    assert.equal(evidence.sheetAnimationWait.status, 'completed')
    assert.equal(evidence.sheetAnimationWait.elapsedMs, 50)
    assert.equal(fake.events.at(-1), 'screenshot:2050')
    assert.ok(!fake.events.includes('action-delay'))
    assert.ok(!fake.events.includes('load'))
  }
})

test('unexpected browser inspection errors prevent screenshots', async () => {
  const fake = animatedPage(() => [])
  fake.page.evaluate = () => Promise.reject(new Error('browser disconnected'))
  await assert.rejects(
    captureStep({
      ...fake,
      action: { kind: 'inspect', selector: 'main' },
      screenshot: {},
    }),
    /browser disconnected/,
  )
  assert.deepEqual(fake.events, [])
})

test('pre-screenshot wait follows existing load settling on a phase without clicks', async () => {
  const fake = animatedPage(() => [])
  fake.page.url = () => 'https://localhost/recent'
  await captureStep({
    ...fake,
    action: { kind: 'inspect', selector: 'main' },
    screenshot: {},
  })
  assert.deepEqual(fake.events, ['load', 'inspect', 'screenshot:0'])
})

test('normal full-page PNG selects the style after settling and bounds only the overflow probe', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
  for (const probe of ['overflow', 'fits', 'replaced', 'stalled', 'error']) {
    const fake = animatedPage(() => [])
    fake.page.url = () => 'https://localhost/recent'
    const evaluateAnimations = fake.page.evaluate
    const probeError = new Error('overflow evaluation failed')
    fake.page.evaluate = (fn) => {
      if (!fn.toString().includes('scrollHeight')) return evaluateAnimations(fn)
      fake.events.push('overflow')
      if (probe === 'replaced')
        throw new Error('Execution context was destroyed')
      if (probe === 'stalled') return new Promise(() => {})
      if (probe === 'error') return Promise.reject(probeError)
      return probe === 'overflow'
    }
    const originalOptions = { fullPage: true, path: 'phase.png' }
    fake.page.screenshot = (options) => fake.events.push({ ...options })
    const capture = captureStep({
      ...fake,
      action: { kind: 'inspect', selector: 'main' },
      screenshot: { ...originalOptions },
    })
    if (probe === 'error') {
      await assert.rejects(capture, (error) => error === probeError)
      assert.deepEqual(fake.events, ['load', 'inspect', 'overflow'])
      continue
    }
    await flush()
    if (probe === 'stalled') {
      assert.deepEqual(fake.events, ['load', 'inspect', 'overflow'])
      t.mock.timers.tick(2000)
      await flush()
    }
    assert.deepEqual(fake.events, [
      'load',
      'inspect',
      'overflow',
      probe === 'overflow'
        ? { ...originalOptions, style: fullPageCaptureStyle }
        : originalOptions,
    ])
    await capture
  }
})

test('registered pending clicks retain their observation order before a styled PNG', async () => {
  for (const taskId of ['return-to-recent-file', 'review-new-reactions']) {
    const { action } = taskWalkthroughs
      .find((task) => task.taskId === taskId)
      .steps.find((step) => step.phase === 'pending')
    const fake = animatedPage(() => [])
    if (taskId === 'return-to-recent-file')
      fake.page.url = () => 'https://localhost/recent'
    fake.page.waitForURL = () => {
      fake.events.push('url')
      return Promise.resolve()
    }
    const locator = fake.page.locator()
    locator.isVisible = () => {
      fake.events.push('sheet-visible')
      return true
    }
    const animate = fake.page.evaluate
    fake.page.evaluate = (fn) => {
      if (!fn.toString().includes('scrollHeight')) return animate(fn)
      fake.events.push('overflow')
      return true
    }
    const screenshot = { path: 'pending.png', fullPage: true }
    fake.page.screenshot = (options) => fake.events.push(options)
    await captureStep({ ...fake, action, screenshot })
    assert.deepEqual(fake.events, [
      'click',
      'inspect',
      'sheet-visible',
      'inspect',
      'overflow',
      { ...screenshot, style: fullPageCaptureStyle },
    ])
  }
})

test('Viewer loading PNGs and inspection precede the actual sandbox continuation', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
  for (const taskId of ['republish-updated-file', 'confirm-agent-publish']) {
    const fake = animatedPage(() => [])
    const task = taskWalkthroughs.find((entry) => entry.taskId === taskId)
    let handler
    let loading = false
    let continuation
    const request = () => {
      loading = true
      continuation = handler({
        continue: () => {
          loading = false
        },
      })
    }
    fake.page.route = (_match, callback) => {
      handler = callback
    }
    fake.page.goto = (_url, options) => {
      assert.equal(options.waitUntil, 'domcontentloaded')
      request()
      return { ok: () => true }
    }
    const locator = fake.page.locator()
    fake.page.locator = (selector) => ({
      ...locator,
      waitFor: () => {
        assert.notEqual(selector, '[data-sandbox-state="ready"]')
        if (selector.includes(':not('))
          fake.events.push(['inspection', loading])
        return Promise.resolve()
      },
      click: request,
    })
    fake.page.waitForURL = () => {
      fake.events.push('url')
      return Promise.resolve()
    }
    const animate = fake.page.evaluate
    fake.page.evaluate = (fn) => {
      if (!fn.toString().includes('scrollHeight')) return animate(fn)
      fake.events.push('overflow')
      return new Promise(() => {})
    }
    fake.page.screenshot = (options) =>
      fake.events.push(['png', loading, { ...options }])
    const originalOptions = { fullPage: true, path: 'viewer.png' }
    const phases =
      taskId === 'confirm-agent-publish' ? ['action', 'pending'] : ['pending']
    for (const phase of phases) {
      const capture = captureStep({
        ...fake,
        action: task.steps.find((step) => step.phase === phase).action,
        viewerLoading: true,
        screenshot: { ...originalOptions },
        baseUrl: 'https://localhost',
        state: { cliArtifactId: 'example', initial: { artifactId: 'example' } },
      })
      await flush()
      assert.deepEqual(fake.events.at(-1), ['png', true, originalOptions])
      await capture
    }
    assert.deepEqual(fake.events, [
      ...(phases.length === 2
        ? [
            'load',
            'url',
            'inspect',
            ['png', true, originalOptions],
            ['inspection', true],
          ]
        : []),
      'inspect',
      ['png', true, originalOptions],
    ])
    t.mock.timers.tick(1499)
    await flush()
    assert.equal(loading, true)
    t.mock.timers.tick(1)
    await flush()
    assert.equal(loading, false)
    await continuation
  }
})

test('a stalled browser evaluation reaches the deadline before the PNG', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
  const fake = animatedPage(() => [])
  let inspected
  const inspection = new Promise((resolve) => {
    inspected = resolve
  })
  fake.page.evaluate = () => {
    inspected()
    return new Promise(() => {})
  }
  const capture = captureStep({
    ...fake,
    animationTiming: { now: () => Date.now() },
    action: { kind: 'inspect', selector: 'main' },
    screenshot: {},
  })
  await inspection
  assert.deepEqual(fake.events, [])
  t.mock.timers.tick(2000)
  const evidence = await capture
  assert.deepEqual(evidence.sheetAnimationWait, {
    status: 'timed-out',
    elapsedMs: 2000,
    timeoutMs: 2000,
  })
  assert.deepEqual(fake.events, ['screenshot:0'])
})

test('a settled evaluation returned after the deadline records a timeout', async () => {
  const fake = animatedPage(() => [])
  fake.page.evaluate = () => {
    fake.animationTiming.sleep(2050)
    return true
  }
  const evidence = await captureStep({
    ...fake,
    action: { kind: 'inspect', selector: 'main' },
    screenshot: {},
  })
  assert.deepEqual(evidence.sheetAnimationWait, {
    status: 'timed-out',
    elapsedMs: 2050,
    timeoutMs: 2000,
  })
  assert.equal(fake.events.at(-1), 'screenshot:2050')
})

test('CLI sheet click waits for expansion before inspecting opening animations', async () => {
  let expanded = false
  const fake = animatedPage((time) => [
    [expanded && time < 100 ? 'running' : 'finished'],
  ])
  const originalLocator = fake.page.locator
  fake.page.locator = (selector) => {
    if (!selector.includes('aria-expanded')) return originalLocator(selector)
    return {
      first() {
        return this
      },
      waitFor() {
        expanded = true
        fake.events.push('expanded')
      },
    }
  }
  const evidence = await captureStep({
    ...fake,
    action: { kind: 'gotoCliArtifactAndClick', selector: 'button' },
    screenshot: {},
    baseUrl: 'https://localhost',
    state: { cliArtifactId: 'example' },
  })
  assert.deepEqual(fake.events.slice(0, 3), ['click', 'expanded', 'inspect'])
  assert.equal(evidence.clicked.sheetAnimationWait.elapsedMs, 100)
  assert.equal(evidence.sheetAnimationWait.elapsedMs, 0)
})

test('infinite sheet animations do not delay capture but finite animations still do', async () => {
  const infinite = {
    playState: 'running',
    effect: { getComputedTiming: () => ({ iterations: Infinity }) },
  }
  for (const finiteDuration of [0, 100]) {
    const fake = animatedPage((time) => [
      [infinite],
      [
        {
          playState: time < finiteDuration ? 'running' : 'finished',
          effect: { getComputedTiming: () => ({ iterations: 1 }) },
        },
      ],
    ])
    const evidence = await captureStep({
      ...fake,
      action: { kind: 'inspect', selector: 'main' },
      screenshot: {},
    })
    assert.deepEqual(evidence.sheetAnimationWait, {
      status: 'completed',
      elapsedMs: finiteDuration,
      timeoutMs: 2000,
    })
    assert.equal(fake.events.at(-1), `screenshot:${finiteDuration}`)
    if (finiteDuration === 0)
      assert.deepEqual(fake.events, ['inspect', 'screenshot:0'])
  }
})

test('navigation context replacement is diagnostic and still permits the PNG', async () => {
  const fake = animatedPage(() => [])
  fake.page.evaluate = () => {
    fake.animationTiming.sleep(50)
    return Promise.reject(
      new Error(
        'page.evaluate: Execution context was destroyed, most likely because of a navigation.',
      ),
    )
  }
  const evidence = await captureStep({
    ...fake,
    action: {
      kind: 'inspect',
      selector: 'main',
      captureDuringNavigation: true,
    },
    screenshot: {},
  })
  assert.deepEqual(evidence.sheetAnimationWait, {
    status: 'context-replaced',
    elapsedMs: 50,
    timeoutMs: 2000,
  })
  assert.equal(fake.events.at(-1), 'screenshot:50')
})

test('branch orchestration preserves phases, isolation, videos and continuous Home observations', async (t) => {
  const { mkdtemp, writeFile, readFile, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { captureRun, writeTaskIndex } =
    await import('./task-walkthrough-capture.mjs')
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const root = await mkdtemp(join(tmpdir(), 'walkthrough-branches-'))
  try {
    for (const walkthrough of taskWalkthroughs) {
      for (const [viewport, fault] of ['desktop', 'mobile'].flatMap((size) =>
        (walkthrough.continuousHomeReturn
          ? [null, 'unread', 'missing', 'diagnostic-write', 'stalled']
          : [null]
        ).map((problem) => [size, problem]),
      )) {
        const calls = []
        const missingRowError = new Error('target row absent')
        const missingRow = fault === 'missing' || fault === 'diagnostic-write'
        let homePng
        const probeStarted = Promise.withResolvers()
        const homeOptions = {
          path: join(
            root,
            fault
              ? `failed-home-return-${viewport}.png`
              : `supplement-home-read-${viewport}.png`,
          ),
          fullPage: true,
          ...(viewport === 'mobile' && fault !== 'stalled'
            ? { style: fullPageCaptureStyle }
            : {}),
        }
        let serial = 0
        const browser = {
          newContext: async () => {
            const contextNumber = ++serial
            calls.push('context')
            let url = 'https://localhost/'
            let returned = false
            const listeners = {}
            const request = (name) => ({
              url: () => `https://localhost/${name}?t=secret`,
              method: () => 'POST',
              failure: () => ({ errorText: 'aborted' }),
            })
            const lateSuccess = request('late-success')
            const homeRequest = request('home-return')
            const priorProbeRequest = request('prior-probe')
            const locator = (selector) => ({
              first() {
                return this
              },
              count: () => 0,
              all: () => [],
              waitFor: () => {
                if (returned && missingRow && selector.startsWith('main'))
                  throw missingRowError
              },
              innerText: () =>
                selector.includes('data-new-comment')
                  ? 'A new body'
                  : returned && !['unread', 'stalled'].includes(fault)
                    ? 'Target'
                    : '1 new comment',
              getAttribute: () =>
                returned && !['unread', 'stalled'].includes(fault)
                  ? 'Target'
                  : 'Target Unread',
              allInnerTexts: () => Promise.resolve([]),
              locator: (nested) =>
                nested.startsWith('xpath=')
                  ? locator('main row')
                  : {
                      all: () => [
                        {
                          innerText: () =>
                            !returned || ['unread', 'stalled'].includes(fault)
                              ? 'New comment'
                              : '',
                          isVisible: () => true,
                        },
                      ],
                    },
              click: () => {
                calls.push('app-home')
                listeners.requestfailed(lateSuccess)
                listeners.request(homeRequest)
                listeners.requestfailed(homeRequest)
                returned = true
                url = 'https://localhost/'
              },
            })
            const videoPath = join(root, `raw-${contextNumber}.webm`)
            await writeFile(videoPath, 'video')
            return {
              addCookies: async () => {},
              addInitScript: async () => {},
              route: async () => {},
              close: () => {
                calls.push('close')
              },
              newPage: () => ({
                locator,
                on: (event, listener) => {
                  listeners[event] = listener
                },
                startSuccessRequests: () => {
                  const failed = request('success')
                  listeners.request(failed)
                  listeners.requestfailed(failed)
                  listeners.request(lateSuccess)
                  listeners.request(priorProbeRequest)
                },
                frames: () => [],
                url: () => url,
                evaluate: (fn) => {
                  if (!fn.toString().includes('scrollHeight')) return true
                  if (fault) {
                    const duringProbe = request('home-probe')
                    listeners.request(duringProbe)
                    listeners.requestfailed(duringProbe)
                    listeners.requestfailed(priorProbeRequest)
                  }
                  calls.push('overflow')
                  probeStarted.resolve()
                  if (fault === 'stalled') return new Promise(() => {})
                  return viewport === 'mobile'
                },
                screenshot: async (options) => {
                  homePng = options
                  const { path } = options
                  calls.push('home-png')
                  if (fault === 'diagnostic-write')
                    throw new Error('diagnostic write failed')
                  await writeFile(path, 'png')
                },
                waitForURL: async () => {},
                video: () => ({ path: () => videoPath }),
                setUrl: (value) => {
                  url = value
                },
              }),
            }
          },
        }
        const session = {
          cookies: [],
          initializationId: `${viewport}-init`,
          workspaceId: 'fixture',
          userId: 'fixture',
        }
        const capturing = captureRun({
          browser,
          walkthrough,
          persona: { auth: 'fixture' },
          viewport,
          baseUrl: 'https://localhost',
          outDir: root,
          outputRoot: root,
          session,
          sharedState: {
            artifactIndex: walkthrough.artifactIndex,
            cliArtifactIds: [],
          },
          initialize: () => {
            calls.push('initialize')
            return { ...session, initializationId: `${viewport}-failure-init` }
          },
          apply: () => {
            calls.push('failure-setup')
          },
          capture: async ({ action, page, screenshot, viewerLoading }) => {
            const phase = walkthrough.steps.find(
              (s) => s.action === action,
            ).phase
            const index = walkthrough.steps.findIndex(
              (s) => s.action === action,
            )
            assert.deepEqual(screenshot, {
              path: join(
                root,
                `${String(index + 1).padStart(2, '0')}-${phase}-${viewport}.png`,
              ),
              fullPage: true,
            })
            assert.equal(
              viewerLoading,
              [
                'republish-updated-file/pending',
                'confirm-agent-publish/action',
                'confirm-agent-publish/pending',
              ].includes(`${walkthrough.taskId}/${phase}`),
            )
            calls.push(phase)
            if (phase === 'failure' && walkthrough.continuousHomeReturn)
              page.setUrl(`https://localhost${action.path}`)
            if (phase === 'success' && walkthrough.continuousHomeReturn) {
              page.setUrl('https://localhost/a/target')
              page.startSuccessRequests()
            }
            await writeFile(screenshot.path, 'png')
            return phase === 'success'
              ? { inspected: { selector: action.selector, visible: true } }
              : {}
          },
        })
        if (fault) {
          const rejected = assert.rejects(
            capturing,
            missingRow
              ? (error) => error === missingRowError
              : /remains unread/,
          )
          if (fault === 'stalled') {
            await probeStarted.promise
            t.mock.timers.tick(2000)
            await flush()
            assert.deepEqual(homePng, homeOptions)
          }
          await rejected
          assert.deepEqual(homePng, homeOptions)
          assert.equal(calls[calls.indexOf('home-png') - 1], 'overflow')
          assert.ok(calls.includes('success'))
          assert.ok(calls.includes('app-home'))
          assert.equal(calls.at(-1), 'close')
          assert.ok(!calls.includes('initialize'))
          assert.ok(calls.includes('home-png'))
          const diagnostic = JSON.parse(
            await readFile(
              join(root, `failed-home-return-${viewport}.json`),
              'utf8',
            ),
          )
          assert.deepEqual(diagnostic.evidence.failedRequests, [
            {
              url: 'https://localhost/home-return?t=%5Bredacted%5D',
              method: 'POST',
              failure: 'aborted',
            },
          ])
          assert.deepEqual(diagnostic.evidence.lateOriginFailures, {
            success: [
              {
                url: 'https://localhost/late-success?t=%5Bredacted%5D',
                method: 'POST',
                failure: 'aborted',
              },
            ],
          })
          assert.equal(diagnostic.status, 'failed')
          assert.equal(diagnostic.final.visible, !missingRow)
          if (!missingRow) assert.equal(diagnostic.final.unread, true)
          assert.equal(diagnostic.inspection.body, 'A new body')
          assert.equal(
            diagnostic.file,
            fault === 'diagnostic-write'
              ? null
              : `failed-home-return-${viewport}.png`,
          )
          assert.equal(
            await readFile(join(root, `04-success-${viewport}.png`), 'utf8'),
            'png',
          )
          continue
        }
        const record = await capturing
        assert.deepEqual(
          record.steps.map((s) => s.phase),
          [
            'start',
            'action',
            'pending',
            'success',
            'failure',
            'recovery',
            'next',
          ],
        )
        assert.equal(calls.filter((c) => c === 'context').length, 2)
        assert.equal(calls.filter((c) => c === 'initialize').length, 1)
        assert.ok(calls.indexOf('success') < calls.indexOf('close'))
        assert.ok(calls.indexOf('close') < calls.indexOf('initialize'))
        assert.ok(calls.indexOf('initialize') < calls.indexOf('failure'))
        assert.notEqual(record.steps[3].contextId, record.steps[4].contextId)
        assert.notEqual(
          record.steps[3].initializationId,
          record.steps[4].initializationId,
        )
        assert.equal(record.steps[4].continues, false)
        const ordered = record.steps.flatMap((s) => [
          s,
          ...(s.phase === 'success' ? record.supplements : []),
        ])
        for (const video of record.videos) {
          assert.deepEqual(
            video.stepIds,
            ordered
              .filter((s) => s.branchId === video.branchId)
              .map((s) => s.id),
          )
          for (const step of ordered.filter(
            (s) => s.branchId === video.branchId,
          ))
            assert.equal(step.video, video.file)
        }
        if (walkthrough.continuousHomeReturn) {
          assert.deepEqual(homePng, homeOptions)
          assert.ok(calls.indexOf('success') < calls.indexOf('app-home'))
          assert.ok(calls.indexOf('home-png') < calls.indexOf('close'))
          // Navigation failures belong to their initiation phase. A late
          // success abort must neither mutate its saved PNG facts nor move Home.
          assert.deepEqual(record.steps[3].evidence.failedRequests, [
            {
              url: 'https://localhost/success?t=%5Bredacted%5D',
              method: 'POST',
              failure: 'aborted',
            },
          ])
          assert.deepEqual(record.supplements[0].evidence.failedRequests, [
            {
              url: 'https://localhost/home-return?t=%5Bredacted%5D',
              method: 'POST',
              failure: 'aborted',
            },
          ])
          assert.equal(record.supplements[0].result.final.unread, false)
          assert.equal(
            record.supplements[0].result.inspection.body,
            'A new body',
          )
          assert.equal(record.supplements[0].predecessorId, record.steps[3].id)
          assert.notEqual(record.supplements[0].file, record.steps[3].file)
        }
        const serialized = JSON.parse(JSON.stringify(record))
        if (walkthrough.continuousHomeReturn) {
          assert.deepEqual(serialized.supplements[0].evidence, {
            failedRequests: [
              {
                url: 'https://localhost/home-return?t=%5Bredacted%5D',
                method: 'POST',
                failure: 'aborted',
              },
            ],
            lateOriginFailures: {
              success: [
                {
                  url: 'https://localhost/late-success?t=%5Bredacted%5D',
                  method: 'POST',
                  failure: 'aborted',
                },
              ],
            },
          })
        }
        await writeTaskIndex(root, {
          task: { title: '<unsafe>', goal: 'Review' },
          runs: [serialized],
        })
        const html = await readFile(join(root, 'index.html'), 'utf8')
        assert.ok(html.includes('&lt;unsafe&gt;'))
        assert.ok(html.includes('overflow-wrap:anywhere'))
        for (const step of ordered) {
          assert.ok(html.includes(step.file))
          assert.ok(html.includes(step.contextId))
          assert.ok(html.includes(step.branchId))
          assert.ok(html.includes(step.initializationId))
          assert.ok(html.includes(step.video))
        }
        assert.ok(html.includes('Reset: independent failure initialization'))
        assert.ok(html.includes('field-specific fixture refresh'))
        if (walkthrough.continuousHomeReturn)
          assert.equal(
            record.steps[4].evidence.reactionFailure.recentReactionCueVisible,
            false,
          )
        if (walkthrough.continuousHomeReturn) {
          assert.equal(html.split('&quot;inspectionStepId&quot;').length - 1, 1)
          assert.ok(
            html.indexOf('Continuous Home return:') <
              html.indexOf('<h2>failure'),
          )
        }
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('reaction action opens the target already observed on Home', async () => {
  let url = 'https://localhost/'
  const clicked = []
  const page = {
    url: () => url,
    waitForLoadState: () => Promise.resolve(),
    waitForURL: () => Promise.resolve(),
    evaluate: () => Promise.resolve(true),
    screenshot: () => Promise.resolve(),
    locator: (selector) => ({
      first() {
        return this
      },
      waitFor: () => Promise.resolve(),
      click: () => {
        clicked.push(selector)
        url = 'https://localhost/a/observed-target'
      },
    }),
  }
  const result = await captureStep({
    page,
    action: { kind: 'clickUnreadArtifact' },
    baseUrl: 'https://localhost',
    session: {},
    state: { initial: { artifactId: 'observed-target' } },
    screenshot: {},
  })
  assert.equal(result.clicked.destination, '/a/observed-target')
  assert.ok(clicked[0].includes('/a/observed-target'))
})

test('reaction row reads sibling content, combined segments and visible mobile previews', async () => {
  const { createRequire } = await import('node:module')
  const { Window } = createRequire(
    new URL('../apps/web/package.json', import.meta.url),
  )('happy-dom')
  const { observeReactionRow } = await import('./task-walkthrough-capture.mjs')
  const document = new Window().document
  for (const [markup, expected] of [
    ['<span>v2 · 2 new comments</span>', true],
    ['<span><span aria-hidden="true"> · </span>1 new comment</span>', true],
    [
      '<span><span aria-hidden="true"> · </span>v2 · 新着コメント 2件</span>',
      true,
    ],
    [
      '<span hidden>v2 · 2 new comments</span><span><span>New comment</span><span>Preview body</span></span>',
      true,
    ],
    ['<span hidden>2 new comments</span><span>v2</span>', false],
    ['<span title="New comment">New comment</span><span>v2</span>', false],
  ]) {
    document.body.innerHTML = `<main><div data-slot="file-row"><a href="/a/target" aria-label="Target · Unread updates"></a><div>${markup}</div></div><div data-slot="file-row"><a href="/a/other"></a><span>New comment</span></div></main>`
    const link = document.querySelector('a')
    const row = link.closest('[data-slot="file-row"]')
    const page = {
      locator(selector) {
        assert.equal(document.querySelector(selector), link)
        return {
          first: () => ({
            waitFor: async () => {},
            innerText: () => link.textContent,
            getAttribute: (name) => link.getAttribute(name),
            locator: (relation) =>
              relation.startsWith('xpath=')
                ? {
                    waitFor: async () => {},
                    innerText: () => row.textContent,
                    locator: (spans) => ({
                      all: () =>
                        [...row.querySelectorAll(spans)].map((element) => ({
                          innerText: () => element.textContent,
                          isVisible: () => !element.closest('[hidden]'),
                        })),
                    }),
                  }
                : { all: () => [] },
          }),
        }
      },
    }
    if (expected) {
      const observation = await observeReactionRow(page, 'target', true)
      assert.equal(observation.newComments, true)
      assert.equal(observation.href, '/a/target')
      assert.ok(observation.text.length > 0)
    } else {
      await assert.rejects(
        observeReactionRow(page, 'target', true),
        /Initial target must show unread comments/,
      )
    }
  }
})

test('reaction failure requires visible selected project filter and no target recent row', async () => {
  const { observeReactionFailure } =
    await import('./task-walkthrough-capture.mjs')
  for (const fault of [null, 'unfiltered', 'hidden-filter', 'target-present']) {
    const page = {
      url: () =>
        `https://localhost/${fault === 'unfiltered' ? '' : '?relation=project'}`,
      locator: (selector) => {
        if (selector.startsWith('main nav')) {
          assert.match(selector, /aria-current="page"/)
          assert.match(selector, /href="\/\?relation=project"/)
          return {
            first: () => ({
              waitFor: () => {
                if (fault === 'hidden-filter')
                  throw new Error('selected filter not visible')
              },
              innerText: () => 'Project',
            }),
          }
        }
        assert.equal(
          selector,
          'main [data-slot="file-row"] a[href="/a/target"]',
        )
        return {
          all: () =>
            fault === 'target-present' ? [{ isVisible: () => true }] : [],
        }
      },
    }
    const observation = observeReactionFailure(page, 'target')
    if (fault) {
      await assert.rejects(
        observation,
        fault === 'unfiltered'
          ? /project-filtered Home/
          : fault === 'hidden-filter'
            ? /selected filter not visible/
            : /target remains in recent rows/,
      )
    } else {
      assert.deepEqual(await observation, {
        artifactId: 'target',
        href: '/a/target',
        filter: 'project',
        filterLabel: 'Project',
        filterVisible: true,
        targetRecentRowVisible: false,
        recentReactionCueVisible: false,
      })
    }
  }
})

test('search interactions perform input, submit, viewport-specific selection and Back without invented evidence', async () => {
  for (const width of [599, 600]) {
    const events = []
    const page = {
      viewportSize: () => ({ width }),
      url: () => 'https://localhost/search',
      goBack: () => {
        events.push('back')
        return Promise.resolve()
      },
      locator: (selector) => ({
        waitFor: () => Promise.resolve(events.push(`ready:${selector}`)),
        fill: (value) => Promise.resolve(events.push(`fill:${value}`)),
        press: (key) => Promise.resolve(events.push(`press:${key}`)),
        selectOption: (value) =>
          Promise.resolve(events.push(`select:${selector}:${value}`)),
      }),
      evaluate: () => Promise.resolve([]),
      waitForLoadState: async () => {},
      screenshot: () => Promise.resolve(events.push('screenshot')),
    }
    const evidence = await captureStep({
      page,
      screenshot: {},
      action: {
        kind: 'sequence',
        steps: [
          {
            kind: 'fill',
            selector: 'keywords',
            value: 'Quarterly',
            submit: true,
          },
          { kind: 'back' },
        ],
        mobileSteps: [
          { kind: 'select', selector: 'sheet-sort', value: 'newest' },
        ],
        desktopSteps: [
          { kind: 'select', selector: 'row-sort', value: 'newest' },
        ],
      },
    })
    assert.ok(events.includes('fill:Quarterly'))
    assert.ok(events.includes('press:Enter'))
    assert.ok(events.includes('back'))
    assert.ok(
      events.includes(
        `select:${width < 600 ? 'sheet-sort' : 'row-sort'}:newest`,
      ),
    )
    assert.equal(evidence.interactions.length, 3)
    page.locator = () => ({
      waitFor: () => Promise.reject(new Error('missing keyword field')),
    })
    await assert.rejects(
      captureStep({
        page,
        screenshot: {},
        action: { kind: 'fill', selector: 'keywords', value: 'Quarterly' },
      }),
      /missing keyword field/,
    )
  }
})
