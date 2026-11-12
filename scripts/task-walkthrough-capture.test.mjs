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

test('branch orchestration preserves phases, isolation, videos and continuous Home observations', async () => {
  const { mkdtemp, writeFile, readFile, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { captureRun, writeTaskIndex } =
    await import('./task-walkthrough-capture.mjs')
  const { taskWalkthroughs } = await import('./task-walkthroughs.mjs')
  const root = await mkdtemp(join(tmpdir(), 'walkthrough-branches-'))
  try {
    for (const walkthrough of taskWalkthroughs) {
      for (const [viewport, fault] of ['desktop', 'mobile'].flatMap((size) =>
        (walkthrough.continuousHomeReturn
          ? [null, 'unread', 'missing']
          : [null]
        ).map((problem) => [size, problem]),
      )) {
        const calls = []
        let serial = 0
        const browser = {
          newContext: async () => {
            const contextNumber = ++serial
            calls.push('context')
            let url = 'https://localhost/'
            let returned = false
            const locator = (selector) => ({
              first() {
                return this
              },
              count: () => 0,
              waitFor: () => {
                if (
                  returned &&
                  fault === 'missing' &&
                  selector.startsWith('main')
                )
                  throw new Error('target row absent')
              },
              innerText: () =>
                selector.includes('data-new-comment')
                  ? 'A new body'
                  : returned && fault !== 'unread'
                    ? 'Target'
                    : '1 new comment',
              getAttribute: () =>
                returned && fault !== 'unread' ? 'Target' : 'Target Unread',
              allInnerTexts: () => Promise.resolve([]),
              locator: () => ({
                all: () => [
                  {
                    innerText: () =>
                      !returned || fault === 'unread' ? 'New comment' : '',
                    isVisible: () => true,
                  },
                ],
              }),
              click: () => {
                calls.push('app-home')
                returned = true
                url = 'https://localhost/'
              },
            })
            const videoPath = join(root, `raw-${contextNumber}.webm`)
            await writeFile(videoPath, 'video')
            return {
              addCookies: async () => {},
              addInitScript: async () => {},
              close: () => {
                calls.push('close')
              },
              newPage: () => ({
                locator,
                on: () => {},
                frames: () => [],
                url: () => url,
                evaluate: () => true,
                screenshot: async ({ path }) => {
                  calls.push('home-png')
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
          capture: async ({ action, page, screenshot }) => {
            const phase = walkthrough.steps.find(
              (s) => s.action === action,
            ).phase
            calls.push(phase)
            if (phase === 'success' && walkthrough.continuousHomeReturn)
              page.setUrl('https://localhost/a/target')
            await writeFile(screenshot.path, 'png')
            return phase === 'success'
              ? { inspected: { selector: action.selector, visible: true } }
              : {}
          },
        })
        if (fault) {
          await assert.rejects(
            capturing,
            fault === 'unread' ? /remains unread/ : /target row absent/,
          )
          assert.ok(calls.includes('success'))
          assert.ok(calls.includes('app-home'))
          assert.equal(calls.at(-1), 'close')
          assert.ok(!calls.includes('initialize'))
          assert.ok(!calls.includes('home-png'))
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
          assert.ok(calls.indexOf('success') < calls.indexOf('app-home'))
          assert.ok(calls.indexOf('home-png') < calls.indexOf('close'))
          assert.equal(record.supplements[0].result.final.unread, false)
          assert.equal(
            record.supplements[0].result.inspection.body,
            'A new body',
          )
          assert.equal(record.supplements[0].predecessorId, record.steps[3].id)
          assert.notEqual(record.supplements[0].file, record.steps[3].file)
        }
        const serialized = JSON.parse(JSON.stringify(record))
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
        if (walkthrough.continuousHomeReturn)
          assert.ok(
            html.indexOf('Continuous Home return:') <
              html.indexOf('<h2>failure'),
          )
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
