import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, test, vi } from 'vitest'
import { page } from 'vitest/browser'
import '~/app.css'
import { TooltipProvider } from '~/components/ui/tooltip'
import type { CommentThreadView } from '~/lib/comments'
import {
  isSandboxMessage,
  type AnchorResolutionMessage,
} from '~/lib/csp-reporter'
import en from '~/i18n/en.json'
import { CommentPanel } from './a.$id/+components/comment-panel'
import { SandboxFrame } from './a.$id/+components/sandbox-frame'
import { useViewerComments } from './a.$id/+components/viewer-shell'

// Keep the actual panel, frame controller, and comment state. Only the route
// context and transport are supplied by the fixture.
vi.mock('~/hooks/use-t', async () => {
  const { bindI18n } = await import('~/lib/i18n')
  return { useT: () => bindI18n('en') }
})
vi.mock('react-router', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-router')>()),
  useViewTransitionState: () => false,
  useRevalidator: () => ({ revalidate: vi.fn() }),
}))

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
const quote = 'Review the projected delivery date.'
const threads: CommentThreadView[] = [
  {
    id: 'checking-thread',
    status: 'open',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    resolvedAt: null,
    canResolve: false,
    messages: [],
    subject: {
      kind: 'text',
      state: 'orphaned',
      positionState: 'unchecked',
      quotedText: quote,
      prefixText: '',
      suffixText: '',
      targetPath: '/sandbox-frame-test',
      versionId: 'v1',
      textStart: null,
      textEnd: null,
      cssPath: null,
    },
  },
]

type HarnessProps = {
  sandboxUrl?: string | null
  frameMounted?: boolean
  artifactId?: string
  versionId?: string
  renderType?: string
  initialThreads?: CommentThreadView[]
}
let controller: ReturnType<typeof useViewerComments>
function Harness({
  sandboxUrl = `${window.location.origin}/sandbox-frame-test?t=old`,
  frameMounted = true,
  artifactId = 'abc123def4',
  versionId = 'v1',
  renderType = 'html',
  initialThreads = threads,
}: HarnessProps) {
  const comments = useViewerComments({
    artifactId,
    currentUserId: 'viewer',
    currentVersionId: versionId,
    anchorFrameKey: sandboxUrl
      ? `${artifactId}:${versionId}:${renderType}`
      : null,
    initialThreads,
    targetCommentId: null,
    liveEnabled: false,
  })
  controller = comments
  return (
    <TooltipProvider>
      <div style={{ height: '100vh' }}>
        {sandboxUrl && frameMounted ? (
          <SandboxFrame
            key={comments.anchorFrameKey}
            shareableId={artifactId}
            versionId={versionId}
            url={sandboxUrl}
            name="Comment recovery fixture"
            mermaidEnabled={false}
            textAnchorsEnabled
            linkNavigationMode="document"
            bundlePaths={[]}
            fallbackToIndex={false}
            commentThreads={comments.state.threads}
            onAnchorCheckingChange={comments.setAnchorCheckingAvailable}
            onAnchorReady={comments.startAnchorCheckingCycle}
            onAnchorResolutions={comments.applyAnchorResolutions}
            targetThreadId={null}
            highlightThreadId={null}
            followsAppTheme
            onTextSelection={() => {}}
            onTextSelectionClear={() => {}}
            onThreadSelect={() => {}}
            onOutsidePointerDown={() => {}}
            sandboxPermissions="allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox allow-downloads"
          />
        ) : null}
      </div>
      <CommentPanel
        shareableId="abc123def4"
        viewerUserId="viewer"
        threads={comments.panelThreads}
        onThreadsChange={comments.replaceThreads}
        isCurrentShareableId={comments.isCurrentArtifactId}
        open
        onOpenChange={comments.changePanelOpen}
        targetThreadId={null}
        targetThreadScroll="center"
        onThreadNavigate={() => {}}
      />
      <output
        hidden
        data-saved-subject={JSON.stringify(comments.state.threads[0].subject)}
      />
    </TooltipProvider>
  )
}

let root: Root | undefined
let captureStyle: HTMLStyleElement | undefined

afterEach(async () => {
  if (root) await act(async () => root?.unmount())
  root = undefined
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  captureStyle?.remove()
  document.body.replaceChildren()
  delete document.documentElement.dataset.theme
})

async function mount(props: HarnessProps = {}) {
  document.documentElement.dataset.theme = 'light'
  captureStyle = document.createElement('style')
  captureStyle.textContent =
    '*,*::before,*::after{animation:none!important;transition:none!important}'
  document.head.appendChild(captureStyle)
  const host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => root?.render(<Harness {...props} />))
  const frame = host.querySelector('iframe')
  if (frame) await silenceFrame(frame)
  return host
}

async function silenceFrame(frame: HTMLIFrameElement) {
  // A loaded but silent document models a frame that cannot run its reporter.
  // Settling this load prevents native load events from racing the fake clock.
  await act(async () => {
    await new Promise<void>((resolve) => {
      const loaded = () => {
        if (frame.contentDocument?.title !== 'Silent frame') return
        frame.removeEventListener('load', loaded)
        resolve()
      }
      frame.addEventListener('load', loaded)
      frame.srcdoc =
        '<!doctype html><title>Silent frame</title><p>Comment recovery fixture</p>'
    })
  })
}

function subject() {
  const card = [...document.querySelectorAll('article')].find((element) =>
    element.textContent?.includes(quote),
  )
  expect(card).toBeDefined()
  const quotedText = [...card!.querySelectorAll('span')].find((element) =>
    element.textContent?.includes(quote),
  )!
  expect(quotedText.checkVisibility()).toBe(true)
  return quotedText.parentElement!
}

function state(host: HTMLElement) {
  return host
    .querySelector('[data-sandbox-state]')
    ?.getAttribute('data-sandbox-state')
}

async function ready(host: HTMLElement, token = 'a'.repeat(64)) {
  const frame = host.querySelector('iframe')!
  const sent = vi.spyOn(frame.contentWindow!, 'postMessage')
  await act(async () => frame.dispatchEvent(new Event('load')))
  const check = sent.mock.calls.find(
    ([message]) => message.kind === 'ready-check',
  )![0]
  await readyReply(host, check.challenge, token)
  sent.mockRestore()
  expect(state(host)).toBe('ready')
  return check
}

async function readyReply(
  host: HTMLElement,
  challenge: string,
  token = 'a'.repeat(64),
) {
  await act(async () => {
    window.dispatchEvent(
      new MessageEvent('message', {
        origin: window.location.origin,
        source: host.querySelector('iframe')!.contentWindow,
        data: {
          source: 'artifactshare',
          kind: 'ready',
          challenge,
          token,
        },
      }),
    )
  })
}

// These captures are evidence, not platform-dependent pixel baselines. Vitest
// saves them alongside this test under __screenshots__ for inspection after a run.
for (const width of [1280, 390]) {
  for (const failure of ['failed', 'never-ready', 'suspended'] as const) {
    test(`actual comment cards stop checking for ${failure} frames (${width}px)`, async ({
      annotate,
    }) => {
      await page.viewport(width, 900)
      vi.useFakeTimers({
        toFake: [
          'setTimeout',
          'clearTimeout',
          'setInterval',
          'clearInterval',
          'Date',
        ],
      })
      const transport = vi.fn((input: RequestInfo | URL) => {
        const url = String(input)
        if (url.includes('/__artifactshare_probe')) {
          if (failure === 'never-ready') return new Promise<Response>(() => {})
          if (failure === 'failed')
            return Promise.resolve(new Response('', { status: 403 }))
          return Promise.resolve(
            new Response('artifactshare-sandbox-probe-v1', {
              headers: {
                'X-ArtifactShare-Sandbox-Probe':
                  'artifactshare-sandbox-probe-v1',
              },
            }),
          )
        }
        // A suspended frame cannot recover its document. The real controller
        // reaches the manual paused state after the recovery request fails.
        if (url.includes('/sandbox-token'))
          return Promise.resolve(new Response('', { status: 503 }))
        return Promise.resolve(new Response(null, { status: 204 }))
      })
      vi.stubGlobal('fetch', transport)
      const host = await mount()
      if (failure === 'suspended') {
        await ready(host)
        // Simulate restoring a suspended page whose frame no longer replies.
        await act(async () => {
          window.dispatchEvent(
            new PageTransitionEvent('pageshow', { persisted: true }),
          )
          await vi.advanceTimersByTimeAsync(500)
        })
      }
      expect(state(host)).toBe('loading')
      const before = subject()
      expect(before.innerText).toContain(en['comments.positionChecking'])
      expect(before.className).not.toContain('text-warning')
      const border = getComputedStyle(before).borderColor
      const savedSubject = host
        .querySelector('[data-saved-subject]')!
        .getAttribute('data-saved-subject')
      expect(savedSubject).toBe(JSON.stringify(threads[0].subject))
      const beforePath = await page.screenshot({
        path: `__screenshots__/comment-recovery-${failure}-${width}-before.png`,
      })
      await annotate('Before: checking the text comment position', {
        path: beforePath,
        contentType: 'image/png',
      })

      await act(async () => {
        await vi.advanceTimersByTimeAsync(3001)
      })
      expect(state(host)).toBe(
        failure === 'failed'
          ? 'blocked'
          : failure === 'suspended'
            ? 'paused'
            : 'loading',
      )
      const after = subject()
      expect(after.innerText).toContain(quote)
      expect(after.innerText).not.toContain(en['comments.positionChecking'])
      expect(after.innerText).not.toContain(en['comments.subjectOrphaned'])
      expect(after.className).not.toContain('text-warning')
      expect(getComputedStyle(after).borderColor).toBe(border)
      expect(
        host
          .querySelector('[data-saved-subject]')!
          .getAttribute('data-saved-subject'),
      ).toBe(savedSubject)
      expect(
        transport.mock.calls.some(([input]) =>
          String(input).endsWith('/comments'),
        ),
      ).toBe(false)
      const afterPath = await page.screenshot({
        path: `__screenshots__/comment-recovery-${failure}-${width}-after.png`,
      })
      await annotate('After: retained quote without checking or warning', {
        path: afterPath,
        contentType: 'image/png',
      })

      // A later ready reply must allow checking again, not leave the panel
      // permanently suppressed after the unavailable interval.
      await ready(host)
      expect(subject().innerText).toContain(en['comments.positionChecking'])
      await act(async () => {
        window.dispatchEvent(
          new MessageEvent('message', {
            origin: window.location.origin,
            source: host.querySelector('iframe')!.contentWindow,
            data: {
              source: 'artifactshare',
              kind: 'anchor-resolutions',
              token: 'a'.repeat(64),
              versionId: 'v1',
              targetPath: '/sandbox-frame-test',
              generation: 1,
              results: [
                {
                  threadId: 'checking-thread',
                  state: 'attached',
                  textStart: 0,
                  textEnd: quote.length,
                  textHash: 'b'.repeat(64),
                },
              ],
            },
          }),
        )
      })
      expect(subject().innerText).toContain(quote)
      expect(subject().innerText).not.toContain(en['comments.positionChecking'])
      expect(subject().innerText).not.toContain(en['comments.subjectOrphaned'])
      expect(subject().className).not.toContain('text-warning')
    }, 20_000)
  }
}

function storedNeedsCheck(): CommentThreadView[] {
  return [
    {
      ...threads[0],
      subject: {
        ...threads[0].subject,
        positionState: 'needs-check',
        checking: false,
      } as CommentThreadView['subject'],
    },
    { ...threads[0], id: 'artifact-thread', subject: { kind: 'artifact' } },
  ]
}

function expectPresentation(presentation: 'neutral' | 'checking' | 'warning') {
  const card = subject()
  expect(card.innerText).toContain(quote)
  expect(card.innerText.includes(en['comments.positionChecking'])).toBe(
    presentation === 'checking',
  )
  expect(card.innerText.includes(en['comments.subjectOrphaned'])).toBe(
    presentation === 'warning',
  )
  expect(card.className.includes('text-warning')).toBe(
    presentation === 'warning',
  )
}

function transportFixture() {
  vi.useFakeTimers({
    toFake: [
      'setTimeout',
      'clearTimeout',
      'setInterval',
      'clearInterval',
      'Date',
    ],
  })
  const transport = vi.fn((_input: RequestInfo | URL, _init?: RequestInit) =>
    Promise.resolve(new Response(null, { status: 204 })),
  )
  vi.stubGlobal('fetch', transport)
  return transport
}

async function resolution(
  host: HTMLElement,
  verdict: 'checking' | 'needs-check' | 'attached',
  generation = 1,
  targetPath = '/sandbox-frame-test',
  token = 'a'.repeat(64),
) {
  const message: AnchorResolutionMessage = {
    source: 'artifactshare',
    kind: 'anchor-resolutions',
    token,
    versionId: 'v1',
    targetPath,
    generation,
    results: [
      {
        threadId: 'checking-thread',
        state: verdict,
        textStart: verdict === 'attached' ? 0 : null,
        textEnd: verdict === 'attached' ? quote.length : null,
        textHash: verdict === 'attached' ? 'b'.repeat(64) : null,
      },
    ],
  }
  expect(isSandboxMessage(message)).toBe(true)
  await act(async () => {
    window.dispatchEvent(
      new MessageEvent('message', {
        origin: window.location.origin,
        source: host.querySelector('iframe')!.contentWindow,
        data: message,
      }),
    )
  })
}

function expectTextFirst(first: boolean) {
  const articles = [...document.querySelectorAll('article')]
  expect(articles).toHaveLength(2)
  expect(articles[0].innerText.includes(quote)).toBe(first)
}

test('no sandbox presents unchecked quotes neutrally from the first panel render without position writes', async () => {
  const transport = transportFixture()
  await mount({ sandboxUrl: null })
  expectPresentation('neutral')
  expect(controller.state.threads).toEqual(threads)
  expect(transport).not.toHaveBeenCalled()
  await act(async () => root?.render(<Harness />))
  expectPresentation('checking')
})

test('unmounting the available frame reports unavailable without synthetic positions', async () => {
  const transport = transportFixture()
  const host = await mount()
  await ready(host)
  expectPresentation('checking')
  // Keep the hook identity unchanged to exercise the frame's unmount report.
  await act(async () => root?.render(<Harness frameMounted={false} />))
  expectPresentation('neutral')
  expect(controller.state.threads).toEqual(threads)
  expect(transport).not.toHaveBeenCalled()
})

test('stored needs-check starts checking and keeps its rank until a terminal verdict', async () => {
  const transport = transportFixture()
  const initialThreads = storedNeedsCheck()
  const host = await mount({ initialThreads })
  expectPresentation('checking')
  expectTextFirst(true)
  expect(controller.state.threads).toEqual(initialThreads)
  expect(transport).not.toHaveBeenCalled()
  await ready(host)
  await resolution(host, 'checking')
  expectPresentation('checking')
  expectTextFirst(true)
  expect(transport).not.toHaveBeenCalled()
  await resolution(host, 'needs-check', 2)
  expectPresentation('warning')
  expectTextFirst(false)
  expect(transport).toHaveBeenCalled()
  expect(
    transport.mock.calls.some((args) => String(args[0]).endsWith('/comments')),
  ).toBe(true)
})

test('unavailable stored needs-check switches to checking only while a fresh frame is available', async () => {
  const transport = transportFixture()
  const initialThreads = storedNeedsCheck()
  await mount({ sandboxUrl: null, initialThreads })
  expectPresentation('warning')
  expectTextFirst(false)
  await act(async () =>
    root?.render(<Harness initialThreads={initialThreads} />),
  )
  expectPresentation('checking')
  expectTextFirst(true)
  await act(async () =>
    root?.render(<Harness sandboxUrl={null} initialThreads={initialThreads} />),
  )
  expectPresentation('warning')
  expectTextFirst(false)
  expect(controller.state.threads).toEqual(initialThreads)
  expect(transport).not.toHaveBeenCalled()
})

test('equal stored verdicts rerender and only new documents or frame identity reset them', async () => {
  transportFixture()
  const initialThreads = storedNeedsCheck()
  const host = await mount({ initialThreads })
  await ready(host)
  await resolution(host, 'needs-check')
  expectPresentation('warning')
  expect(controller.state.threads).toEqual(initialThreads)
  await act(async () => controller.setAnchorCheckingAvailable(true))
  expectPresentation('warning')
  await ready(host, 'c'.repeat(64))
  expectPresentation('checking')
  for (const props of [
    { artifactId: 'abc123def4', versionId: 'v1', renderType: 'md' },
    { artifactId: 'abc123def4', versionId: 'v2', renderType: 'md' },
    { artifactId: 'viewer', versionId: 'v2', renderType: 'md' },
  ]) {
    await act(async () =>
      controller.applyAnchorResolutions([
        {
          threadId: 'checking-thread',
          state: 'needs-check',
          textStart: null,
          textEnd: null,
          textHash: null,
        },
      ]),
    )
    expectPresentation('warning')
    await act(async () =>
      root?.render(<Harness {...props} initialThreads={initialThreads} />),
    )
    expectPresentation('checking')
  }
})

test('same-document liveness ready keeps received verdicts and warning rank', async () => {
  const transport = transportFixture()
  const host = await mount({ initialThreads: storedNeedsCheck() })
  await ready(host)
  await resolution(host, 'needs-check')
  expectPresentation('warning')
  const writes = transport.mock.calls.length
  const frame = host.querySelector('iframe')!
  const sent = vi.spyOn(frame.contentWindow!, 'postMessage')
  await act(async () => {
    window.dispatchEvent(
      new PageTransitionEvent('pageshow', { persisted: true }),
    )
  })
  const check = sent.mock.calls.find(
    ([message]) => message.kind === 'ready-check',
  )![0]
  await readyReply(host, check.challenge)
  await act(async () => vi.advanceTimersByTimeAsync(500))
  expect(state(host)).toBe('ready')
  expectPresentation('warning')
  expectTextFirst(false)
  expect(transport.mock.calls).toHaveLength(writes)
})

test('late loading ready replies keep verdicts received after the first reply', async () => {
  transportFixture()
  const host = await mount({ initialThreads: storedNeedsCheck() })
  const frame = host.querySelector('iframe')!
  const sent = vi.spyOn(frame.contentWindow!, 'postMessage')
  await act(async () => vi.advanceTimersByTimeAsync(500))
  const checks = sent.mock.calls
    .map(([message]) => message)
    .filter((message) => message.kind === 'ready-check')
  expect(checks.length).toBeGreaterThanOrEqual(2)
  expect(state(host)).toBe('loading')
  await readyReply(host, checks[0].challenge)
  expectPresentation('checking')
  await resolution(host, 'needs-check')
  expectPresentation('warning')
  await readyReply(host, checks[1].challenge)
  expectPresentation('warning')
  expectTextFirst(false)
})

test('a new reporter document starts checking until its own verdict arrives', async () => {
  transportFixture()
  const initialThreads = storedNeedsCheck()
  const host = await mount({ initialThreads })
  await ready(host)
  await resolution(host, 'needs-check')
  expectPresentation('warning')
  const token = 'c'.repeat(64)
  await ready(host, token)
  expectPresentation('checking')
  expectTextFirst(true)
  expect(controller.state.threads).toEqual(initialThreads)
  await resolution(host, 'needs-check', 1, '/sandbox-frame-test', token)
  expectPresentation('warning')
  expectTextFirst(false)
})

test('recovered entrypoint with as_next accepts thread ids but rejects a mismatched envelope path', async () => {
  const transport = transportFixture()
  transport.mockImplementation((input) => {
    const url = String(input)
    if (url.includes('/__artifactshare_probe')) {
      return Promise.resolve(
        new Response('artifactshare-sandbox-probe-v1', {
          headers: {
            'X-ArtifactShare-Sandbox-Probe': 'artifactshare-sandbox-probe-v1',
          },
        }),
      )
    }
    if (url.includes('/sandbox-token')) {
      return Promise.resolve(
        Response.json({
          sandboxUrl: `${window.location.origin}/index.html?t=fresh`,
          renderType: 'static_site',
        }),
      )
    }
    return Promise.resolve(new Response(null, { status: 204 }))
  })
  const initialThreads = storedNeedsCheck()
  const host = await mount({ initialThreads, renderType: 'static_site' })
  const originalFrame = host.querySelector('iframe')
  await act(async () => {
    await vi.advanceTimersByTimeAsync(3000)
  })
  const recoveredFrame = host.querySelector('iframe')!
  expect(recoveredFrame).not.toBe(originalFrame)
  expect(new URL(recoveredFrame.src).searchParams.get('as_next')).toBe(
    '/sandbox-frame-test?t=old',
  )
  await silenceFrame(recoveredFrame)
  await ready(host)
  await resolution(host, 'needs-check', 1, '/sandbox-frame-test')
  expectPresentation('checking')
  expect(controller.state.threads).toEqual(initialThreads)
  await resolution(host, 'needs-check', 2, '/index.html')
  expectPresentation('warning')
  expectTextFirst(false)
})
