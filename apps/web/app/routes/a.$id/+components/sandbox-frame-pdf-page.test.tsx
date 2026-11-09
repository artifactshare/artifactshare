// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, test, vi } from 'vitest'
import {
  pdfCommentPage,
  PdfPageContext,
  type PdfPageBridge,
} from './pdf-page-context'
import { SandboxFrame } from './sandbox-frame'

vi.mock('react-router', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-router')>()),
  useViewTransitionState: () => false,
}))
vi.mock('~/hooks/use-t', () => ({
  useT: () => ({ locale: 'en', t: (key: string) => key }),
}))
// As on a server-rendered page, the frame keeps no src here, so nothing loads.
vi.mock('~/hooks/use-hydrated', () => ({ useHydrated: () => false }))

const origin = 'https://a-site123abc--v-7631.artifactshareusercontent.com'

afterEach(() => {
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

async function mount(renderType: 'pdf' | 'video') {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const onPageChange = vi.fn()
  const bridge = (
    openRequest: PdfPageBridge['openRequest'] = null,
  ): PdfPageBridge => ({
    page: null,
    onPageChange,
    openRequest,
    openPage: () => {},
  })
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  const render = (value: PdfPageBridge) =>
    act(async () =>
      root.render(
        <PdfPageContext value={value}>
          <SandboxFrame
            renderType={renderType}
            canViewEnvironmentDiagnostics={false}
            shareableId="abc123def4"
            versionId="v1"
            url={`${origin}/Deck.pdf`}
            name="Deck"
            mermaidEnabled={false}
            textAnchorsEnabled={false}
            linkNavigationMode="document"
            bundlePaths={[]}
            fallbackToIndex={false}
            commentThreads={[]}
            targetThreadId={null}
            highlightThreadId={null}
            followsAppTheme={false}
            sandboxPermissions="allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox allow-downloads"
            onTextSelection={() => {}}
            onTextSelectionClear={() => {}}
            onThreadSelect={() => {}}
            onOutsidePointerDown={() => {}}
          />
        </PdfPageContext>,
      ),
    )
  await render(bridge())
  const iframe = host.querySelector('iframe')!
  // The frame's page is not loaded here: a stand-in window receives the
  // app's messages and is the source of the frame's.
  const sent = vi.fn()
  const frameWindow = { postMessage: sent }
  Object.defineProperty(iframe, 'contentWindow', { value: frameWindow })
  const fromFrame = (data: unknown, source: unknown = frameWindow) =>
    act(async () => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data,
          origin,
          source: source as Window,
        }),
      )
    })
  const syncTokens = () =>
    sent.mock.calls.flatMap(([message, target]) =>
      (message as { kind?: string }).kind === 'pdf-page-sync' &&
      target === origin
        ? [(message as { token: string }).token]
        : [],
    )
  const opened = () =>
    sent.mock.calls.flatMap(([message, target]) =>
      (message as { kind?: string }).kind === 'pdf-open-page' &&
      target === origin
        ? [(message as { pageNumber: number }).pageNumber]
        : [],
    )
  const report = (token: string, pageNumber?: number) => ({
    source: 'artifactshare',
    kind: 'pdf-page-changed',
    token,
    ...(pageNumber === undefined
      ? { state: 'unavailable' }
      : { state: 'ready', pageNumber, pageCount: 14 }),
  })
  const ready = { source: 'artifactshare', kind: 'ready' }
  return {
    root,
    iframe,
    onPageChange,
    bridge,
    render,
    fromFrame,
    syncTokens,
    opened,
    report,
    ready,
  }
}

test('takes page reports only from the document holding the latest sync token', async () => {
  const frame = await mount('pdf')
  // Before the document answers the ready check it holds no token.
  await frame.fromFrame(frame.report('d'.repeat(64), 3))
  expect(frame.onPageChange).not.toHaveBeenCalled()

  await frame.fromFrame(frame.ready)
  const [first] = frame.syncTokens()
  expect(first).toMatch(/^[a-f0-9]{64}$/)
  await frame.fromFrame(frame.report(first!, 12))
  expect(frame.onPageChange).toHaveBeenLastCalledWith('v1', {
    pageNumber: 12,
    pageCount: 14,
  })
  // Another window, another token, or a malformed report changes nothing.
  await frame.fromFrame(frame.report(first!, 3), {})
  await frame.fromFrame(frame.report('d'.repeat(64), 3))
  await frame.fromFrame({ ...frame.report(first!, 3), pageNumber: 20 })
  expect(frame.onPageChange).toHaveBeenCalledTimes(1)
  await frame.fromFrame(frame.report(first!))
  expect(frame.onPageChange).toHaveBeenLastCalledWith('v1', null)
  await frame.fromFrame(frame.report(first!, 12))

  // A new document in the same frame clears the page; the previous
  // document's token no longer counts.
  await act(async () => {
    frame.iframe.dispatchEvent(new Event('load'))
  })
  expect(frame.onPageChange).toHaveBeenLastCalledWith('v1', null)
  const calls = frame.onPageChange.mock.calls.length
  await frame.fromFrame(frame.report(first!, 7))
  expect(frame.onPageChange).toHaveBeenCalledTimes(calls)
  await frame.fromFrame(frame.ready)
  const second = frame.syncTokens().at(-1)!
  expect(second).not.toBe(first)
  await frame.fromFrame(frame.report(second, 7))
  expect(frame.onPageChange).toHaveBeenLastCalledWith('v1', {
    pageNumber: 7,
    pageCount: 14,
  })

  await act(async () => frame.root.unmount())
  expect(frame.onPageChange).toHaveBeenLastCalledWith('v1', null)
})

test('opens each chosen page once, only within the shown document', async () => {
  const frame = await mount('pdf')
  // A choice while no page is shown is dropped, not kept for later.
  await frame.render(frame.bridge({ pageNumber: 2 }))
  await frame.fromFrame(frame.ready)
  const [token] = frame.syncTokens()
  await frame.fromFrame(frame.report(token!, 12))
  expect(frame.opened()).toEqual([])

  const choice = { pageNumber: 5 }
  await frame.render(frame.bridge(choice))
  await frame.render(frame.bridge(choice))
  await frame.render(frame.bridge({ pageNumber: 15 }))
  await frame.render(frame.bridge({ pageNumber: 5 }))
  expect(frame.opened()).toEqual([5, 5])
  await act(async () => frame.root.unmount())
})

test('other viewers neither sync nor take page reports', async () => {
  const frame = await mount('video')
  await frame.fromFrame(frame.ready)
  expect(frame.syncTokens()).toEqual([])
  await frame.fromFrame(frame.report('d'.repeat(64), 1))
  expect(frame.onPageChange).not.toHaveBeenCalled()
  await act(async () => frame.root.unmount())
})

test('a new comment takes only a page reported for the current PDF version', () => {
  const shown = { versionId: 'v2', pageNumber: 12 }
  const view = {
    renderType: 'pdf',
    isHistoricalVersion: false,
    currentVersionId: 'v2',
  }
  expect(pdfCommentPage(shown, view)).toBe(shown)
  expect(pdfCommentPage(shown, { ...view, currentVersionId: 'v3' })).toBe(null)
  expect(pdfCommentPage(shown, { ...view, isHistoricalVersion: true })).toBe(
    null,
  )
  expect(pdfCommentPage(shown, { ...view, renderType: 'video' })).toBe(null)
})
