import assert from 'node:assert/strict'
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
} from './task-walkthrough-capture.mjs'
import { championLoopTaskIds } from './task-walkthroughs.mjs'

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

test('derives the recipient link URL used by walkthrough clipboard checks', () => {
  assert.equal(
    linkViewerUrlForCapture('https://localhost:5173', 'abc123def4'),
    'https://abc123def4.localhost:5173/',
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
    redactEvidenceUrl('https://artifact.sandbox.localhost/file.html?t=secret'),
    'https://artifact.sandbox.localhost/file.html?t=%5Bredacted%5D',
  )
  assert.equal(redactEvidenceUrl('not a URL'), 'not a URL')
  assert.equal(
    redactEvidenceText(
      'Loading https://artifact.sandbox.localhost/file.html?t=secret&mode=html',
    ),
    'Loading https://artifact.sandbox.localhost/file.html?t=[redacted]&mode=html',
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
          return animations.map((playState) => ({ playState }))
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
