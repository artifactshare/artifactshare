import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, test, vi } from 'vitest'
import type { CommentThreadView } from '~/lib/comments'
import { SandboxFrame } from './a.$id/+components/sandbox-frame'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

vi.mock('~/hooks/use-t', async () => {
  const { bindI18n } = await import('~/lib/i18n')
  return { useT: () => bindI18n('en') }
})

vi.mock('react-router', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-router')>()),
  useViewTransitionState: () => false,
}))

const BUNDLE_PATHS = ['/index.html', '/second.html']
const START = '/index.html'

function textThread(id: string, targetPath: string): CommentThreadView {
  return {
    id,
    status: 'open',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    resolvedAt: null,
    canResolve: false,
    messageCount: 1,
    replyCount: 0,
    olderCursor: null,
    messages: [],
    subject: {
      kind: 'text',
      state: 'attached',
      quotedText: 'Selected words',
      prefixText: '',
      suffixText: '',
      targetPath,
      versionId: 'v1',
      textStart: null,
      textEnd: null,
      cssPath: null,
    },
  }
}

const THREADS = [
  textThread('thread-second', '/second.html'),
  textThread('thread-absent', '/absent.html'),
]

let root: Root | undefined

afterEach(async () => {
  vi.unstubAllGlobals()
  if (root) await act(async () => root?.unmount())
  root = undefined
  document.body.replaceChildren()
})

async function renderJumpFrame() {
  vi.stubGlobal(
    'fetch',
    vi.fn(() => new Promise<Response>(() => {})),
  )
  const anchorResolutions = vi.fn()
  const host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  const show = async (targetThreadId: string | null) => {
    await act(async () => {
      root!.render(
        <SandboxFrame
          renderType="static_site"
          canViewEnvironmentDiagnostics
          shareableId="abc123def4"
          versionId="v1"
          url={`${window.location.origin}${START}`}
          name="Site"
          mermaidEnabled={false}
          textAnchorsEnabled
          linkNavigationMode="site"
          bundlePaths={BUNDLE_PATHS}
          fallbackToIndex={false}
          commentThreads={THREADS}
          targetThreadId={targetThreadId}
          highlightThreadId={null}
          followsAppTheme={false}
          onAnchorResolutions={anchorResolutions}
          onTextSelection={() => {}}
          onTextSelectionClear={() => {}}
          onThreadSelect={() => {}}
          onOutsidePointerDown={() => {}}
          sandboxPermissions="allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox allow-downloads"
        />,
      )
    })
  }
  await show(null)
  const frame = host.querySelector('iframe')!
  // Give the frame a document of its own so it has a contentWindow to answer
  // the ready check from, the way the real sandbox does.
  await act(async () => {
    await new Promise<void>((resolve) => {
      frame.addEventListener('load', () => resolve(), { once: true })
      frame.srcdoc = '<!doctype html><title>Site</title><p>Page one</p>'
    })
  })
  const post = vi.spyOn(frame.contentWindow!, 'postMessage')
  await act(async () => frame.dispatchEvent(new Event('load')))
  const becomeReady = async () => {
    const check = post.mock.calls.findLast(
      ([message]) => message.kind === 'ready-check',
    )![0] as { challenge: string }
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
      await new Promise((resolve) => requestAnimationFrame(resolve))
    })
  }
  const reportViolation = async () => {
    await act(async () => {
      window.dispatchEvent(
        new MessageEvent('message', {
          origin: window.location.origin,
          source: frame.contentWindow,
          data: {
            source: 'artifactshare',
            kind: 'csp-violation',
            directive: 'script-src',
            blockedURI: 'eval',
            sourceFile: null,
            lineNumber: 1,
            sample: 'alert(1)',
            disposition: 'enforce',
          },
        }),
      )
    })
  }
  const state = () =>
    host
      .querySelector('[data-sandbox-state]')
      ?.getAttribute('data-sandbox-state')
  const framePath = () =>
    new URL(host.querySelector('iframe')!.getAttribute('data-src')!).pathname
  return {
    host,
    show,
    becomeReady,
    reportViolation,
    state,
    framePath,
    anchorResolutions,
  }
}

test('a conversation jump loads the thread’s page and drops the old page’s violations', async () => {
  const frame = await renderJumpFrame()
  await frame.becomeReady()
  expect(frame.state()).toBe('ready')
  expect(frame.framePath()).toBe(START)

  await frame.reportViolation()
  expect(frame.host.querySelector('aside')).not.toBeNull()

  await frame.show('thread-second')

  expect(frame.framePath()).toBe('/second.html')
  expect(frame.state()).toBe('loading')
  // The banner belonged to the page the frame left.
  expect(frame.host.querySelector('aside')).toBeNull()
  expect(frame.anchorResolutions).not.toHaveBeenCalled()
})

test('a thread on a page the bundle does not serve is reported, not navigated to', async () => {
  const frame = await renderJumpFrame()
  await frame.becomeReady()
  await frame.reportViolation()

  await frame.show('thread-absent')

  expect(frame.framePath()).toBe(START)
  expect(frame.state()).toBe('ready')
  // Negative control for the test above: this page keeps its banner, because
  // the frame never left it.
  expect(frame.host.querySelector('aside')).not.toBeNull()
  expect(frame.anchorResolutions).toHaveBeenCalledWith([
    {
      threadId: 'thread-absent',
      state: 'needs-check',
      textStart: null,
      textEnd: null,
      textHash: null,
    },
  ])
})
