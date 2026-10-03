import { act, StrictMode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, expect, test, vi } from 'vitest'
import { page } from 'vitest/browser'
import '~/app.css'
import { TooltipProvider } from '~/components/ui/tooltip'
import type { CommentThreadView } from '~/lib/comments'
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

interface HarnessProps {
  sandboxUrl?: string | null
  onAvailability?: (available: boolean) => void
}
function Harness({
  sandboxUrl = `${window.location.origin}/sandbox-frame-test?t=old`,
  onAvailability,
}: HarnessProps) {
  const comments = useViewerComments({
    framePresent: Boolean(sandboxUrl),
    artifactId: 'abc123def4',
    currentUserId: 'viewer',
    currentVersionId: 'v1',
    initialThreads: threads,
    targetCommentId: null,
    liveEnabled: false,
  })
  return (
    <TooltipProvider>
      <div style={{ height: '100vh' }}>
        {sandboxUrl ? (
          <SandboxFrame
            shareableId="abc123def4"
            versionId="v1"
            url={sandboxUrl}
            name="Comment recovery fixture"
            mermaidEnabled={false}
            textAnchorsEnabled
            linkNavigationMode="document"
            bundlePaths={[]}
            fallbackToIndex={false}
            commentThreads={comments.state.threads}
            onAnchorCheckingChange={(available) => {
              onAvailability?.(available)
              comments.setAnchorCheckingAvailable(available)
            }}
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
        data-panel-subject={JSON.stringify(comments.panelThreads[0].subject)}
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

async function mount(props: HarnessProps = {}, strict = false) {
  document.documentElement.dataset.theme = 'light'
  captureStyle = document.createElement('style')
  captureStyle.textContent =
    '*,*::before,*::after{animation:none!important;transition:none!important}'
  document.head.appendChild(captureStyle)
  const host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () =>
    root?.render(
      strict ? (
        <StrictMode>
          <Harness {...props} />
        </StrictMode>
      ) : (
        <Harness {...props} />
      ),
    ),
  )
  const frame = host.querySelector('iframe')
  if (!frame) return host
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
  return host
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

async function ready(host: HTMLElement) {
  const frame = host.querySelector('iframe')!
  const sent = vi.spyOn(frame.contentWindow!, 'postMessage')
  await act(async () => frame.dispatchEvent(new Event('load')))
  const check = sent.mock.calls.find(
    ([message]) => message.kind === 'ready-check',
  )![0]
  await act(async () => {
    window.dispatchEvent(
      new MessageEvent('message', {
        origin: window.location.origin,
        source: frame.contentWindow,
        data: {
          source: 'artifactshare',
          kind: 'ready',
          challenge: check.challenge,
          token: 'a'.repeat(64),
        },
      }),
    )
  })
  sent.mockRestore()
  expect(state(host)).toBe('ready')
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

for (const width of [1280, 390]) {
  for (const scenario of ['no-url', 'removed', 'strict-replay'] as const) {
    test(`frame presence controls actual comment presentation: ${scenario} (${width}px)`, async () => {
      await page.viewport(width, 900)
      const transport = vi.fn(() =>
        Promise.resolve(new Response(null, { status: 204 })),
      )
      vi.stubGlobal('fetch', transport)
      const availability = vi.fn()
      const host = await mount(
        {
          ...(scenario === 'no-url' ? { sandboxUrl: null } : {}),
          onAvailability: availability,
        },
        scenario === 'strict-replay',
      )
      if (scenario !== 'no-url') {
        expect(subject().innerText).toContain(en['comments.positionChecking'])
      }
      if (scenario === 'strict-replay') {
        expect(availability.mock.calls.slice(0, 3)).toEqual([
          [true],
          [false],
          [true],
        ])
      } else {
        if (scenario === 'removed') {
          await act(async () =>
            root?.render(
              <Harness sandboxUrl={null} onAvailability={availability} />,
            ),
          )
          expect(availability).toHaveBeenLastCalledWith(false)
        }
        expect(subject().innerText).toContain(quote)
        expect(subject().innerText).not.toContain(
          en['comments.positionChecking'],
        )
        expect(subject().innerText).not.toContain(
          en['comments.subjectOrphaned'],
        )
        expect(subject().className).not.toContain('text-warning')
      }
      expect(
        host
          .querySelector('[data-saved-subject]')!
          .getAttribute('data-saved-subject'),
      ).toBe(JSON.stringify(threads[0].subject))
      expect(transport.mock.calls).toHaveLength(0)
      await page.screenshot({
        path: `__screenshots__/comment-presence-${scenario}-${width}.png`,
      })
      // Inverse control through the real frame effect, never a seeded checking flag.
      if (scenario === 'no-url') {
        await act(async () => root?.render(<Harness />))
        expect(subject().innerText).toContain(en['comments.positionChecking'])
      }
    })
  }
}

test('a frame starts checking on the first render before availability effects', async () => {
  const availability = vi.fn()
  const transport = vi.fn(() =>
    Promise.resolve(new Response(null, { status: 204 })),
  )
  vi.stubGlobal('fetch', transport)
  // Server rendering never runs the frame effect. Read the production panel
  // mapping directly because the panel portal itself is client-only.
  const markup = renderToStaticMarkup(<Harness onAvailability={availability} />)
  const rendered = new DOMParser().parseFromString(markup, 'text/html')
  expect(rendered.querySelector('iframe')).not.toBeNull()
  expect(
    rendered
      .querySelector('[data-panel-subject]')!
      .getAttribute('data-panel-subject'),
  ).toBe(JSON.stringify(threads[0].subject))
  expect(
    rendered
      .querySelector('[data-saved-subject]')!
      .getAttribute('data-saved-subject'),
  ).toBe(JSON.stringify(threads[0].subject))
  expect(availability).not.toHaveBeenCalled()
  expect(transport).not.toHaveBeenCalled()

  // The same mapping renders checking once the real panel portal mounts.
  await mount({ onAvailability: availability })
  expect(subject().innerText).toContain(en['comments.positionChecking'])
  expect(subject().className).not.toContain('text-warning')
  expect(transport).not.toHaveBeenCalled()
})
