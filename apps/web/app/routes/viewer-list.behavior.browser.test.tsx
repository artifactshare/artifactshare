// NOTE: vitest browser mode は `$` を含むディレクトリ内のテストファイルを
// 読み込めない (module URL 解決が止まる) ため、このファイルだけ
// `a.$id/+components/` の外に置く。import 先が `$` を含むのは問題ない。
import { useReducer, useRef } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { page } from 'vitest/browser'
import '~/app.css'
import { TooltipProvider } from '~/components/ui/tooltip'
import { fits, waitForBrowserLayout } from '~/test/browser-layout'
import { ViewerChrome } from './a.$id/+components/viewer-chrome'
import { ViewerListPanel } from './a.$id/+components/viewer-list-panel'
import {
  createViewerShellState,
  viewerShellReducer,
  type ViewerListOpenedFrom,
} from './a.$id/+components/viewer-shell-state'
import { useViewerList } from './a.$id/+hooks/use-viewer-list'

// root loader が無い harness のため locale を en に固定した実カタログを使う。
vi.mock('~/hooks/use-t', async () => {
  const { bindI18n } = await import('~/lib/i18n')
  return { useT: () => bindI18n('en') }
})

// MemoryRouter は data router ではないため、revalidator を使う hooks を差し替える。
vi.mock('./a.$id/+hooks/use-remove-artifact', () => ({
  useRemoveArtifact: () => () => {},
}))

vi.mock('./a.$id/+hooks/use-edit-title', () => ({
  useEditTitle: () => ({
    isEditing: false,
    value: '',
    start: () => {},
    change: () => {},
    submit: () => Promise.resolve(),
    cancel: () => {},
  }),
}))

vi.mock('~/components/app/avatar-menu', () => ({
  // Preserve the real viewer trigger's responsive footprint. A text button
  // here steals width from the adjacent meta row only in this test harness.
  AvatarMenu: () => (
    <button
      type="button"
      className="max-phone:size-7.5 inline-flex size-6.5 shrink-0 items-center justify-center border-0 p-0"
      aria-label="Account"
    >
      V
    </button>
  ),
}))

vi.mock('~/components/app/analytics-consent-provider', () => ({
  useAnalyticsConsent: () => ({
    openBanner: () => {},
    setCommentPanelOpen: () => {},
  }),
}))

const artifact = {
  id: 's1',
  storageKey: 's1/index.html',
  name: 'demo.html',
  derivedTitle: 'Demo document with a fairly long title',
  titleOverride: null,
  ownerId: 'owner-1',
  ownerName: 'Owner Person',
  ownerEmail: 'owner@example.com',
  ownerImage: null,
  ownerInitial: 'O',
  modifiedTime: '2026-08-01T00:00:00.000Z',
  viewCount: 40,
  canReplaceFile: false,
  canViewHistory: false,
  canChangeVisibility: false,
  showViewerListMetaEntry: true,
  viewerListCount: 12,
}

const user = {
  id: 'viewer-1',
  email: 'viewer@example.com',
  name: 'Viewer',
  image: null,
  initial: 'V',
}

const viewersResponse = {
  viewers: [
    {
      userId: 'viewer-1',
      name: 'Viewer',
      image: null,
      lastViewedAt: '2026-08-17T00:00:00.000Z',
      isSelf: true,
      isExternal: false,
    },
    {
      userId: 'viewer-2',
      name: 'Alice Cooper',
      image: null,
      lastViewedAt: '2026-08-16T00:00:00.000Z',
      isSelf: false,
      isExternal: false,
    },
  ],
  nextCursor: null,
  totalViewers: 2,
}

// ViewerShell の閲覧者リスト部分と同じ配線 (reducer + useViewerList + 実 chrome
// + 実パネル) を持つ harness。browser テストで検証するのは CSS 挙動 (狭い幅での
// 非クリッピング / リサイズ維持) で、フル shell の配線自体は happy-dom テスト
// (viewer-list-wiring.test.tsx) が担う。
function Harness({ ownerName = artifact.ownerName }: { ownerName?: string }) {
  const [state, dispatch] = useReducer(
    viewerShellReducer,
    artifact.id,
    createViewerShellState,
  )
  const viewerList = useViewerList({
    artifactId: artifact.id,
    open: state.viewerListOpen,
  })
  const returnFocusRef = useRef<HTMLElement | null>(null)
  const handleEntry = (
    from: ViewerListOpenedFrom,
    returnFocusTo: HTMLElement | null,
  ) => {
    if (from === 'meta' && state.viewerListOpen) {
      dispatch({ type: 'viewer-list-open-changed', open: false })
      return
    }
    returnFocusRef.current = returnFocusTo
    viewerList.openFetch()
    dispatch({ type: 'viewer-list-open-changed', open: true })
  }
  return (
    <TooltipProvider>
      <ViewerChrome
        artifact={{ ...artifact, ownerName }}
        user={user}
        renderType="html"
        viewerListOpen={state.viewerListOpen}
        onViewerListEntrySelect={handleEntry}
        collapsible={false}
      />
      <ViewerListPanel
        open={state.viewerListOpen}
        onOpenChange={(open) => {
          if (open) viewerList.openFetch()
          dispatch({ type: 'viewer-list-open-changed', open })
        }}
        rows={viewerList.rows}
        totalViewers={viewerList.totalViewers}
        status={viewerList.status}
        loadingMore={viewerList.loadingMore}
        nextCursor={viewerList.nextCursor}
        onLoadMore={viewerList.loadMore}
        onRetry={viewerList.retry}
        returnFocusRef={returnFocusRef}
      />
    </TooltipProvider>
  )
}

function visibleWidth(element: Element) {
  return new Promise<number>((resolve) => {
    const observer = new IntersectionObserver(([entry]) => {
      observer.disconnect()
      resolve(entry!.intersectionRect.width)
    })
    observer.observe(element)
  })
}

describe('viewer list browser behavior', () => {
  let root: Root
  let container: HTMLDivElement
  let viewerFetchCount: number

  beforeEach(() => {
    viewerFetchCount = 0
    const originalFetch = window.fetch.bind(window)
    vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes('/viewers')) {
        viewerFetchCount += 1
        return Promise.resolve(
          new Response(JSON.stringify(viewersResponse), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        )
      }
      return originalFetch(input, init)
    })
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    root.unmount()
    container.remove()
    vi.unstubAllGlobals()
  })

  async function renderHarness(ownerName?: string) {
    root.render(
      <MemoryRouter initialEntries={['/a/s1']}>
        <Harness ownerName={ownerName} />
      </MemoryRouter>,
    )
    await vi.waitFor(() => {
      expect(container.querySelector('[data-viewer-list-entry]')).not.toBeNull()
    })
  }

  function entryButton(): HTMLButtonElement {
    const button = container.querySelector<HTMLButtonElement>(
      '[data-viewer-list-entry]',
    )
    if (!button) throw new Error('viewer list entry button not found')
    return button
  }

  it('keeps the meta segment unclipped at a 390px viewport', async () => {
    await page.viewport(390, 844)
    await renderHarness()
    await waitForBrowserLayout()
    const button = entryButton()
    expect(button.scrollWidth).toBeLessThanOrEqual(button.clientWidth)
    const rect = button.getBoundingClientRect()
    expect(rect.right).toBeLessThanOrEqual(390)
    expect(rect.width).toBeGreaterThan(0)
  })

  it('collapses a long owner name inside the meta row with its separator at the narrowest width that shows it', async () => {
    const ownerName = 'Owner Person With A Considerably Longer Display Name'
    await page.viewport(520, 844)
    await renderHarness(ownerName)
    await waitForBrowserLayout()
    const segment = container.querySelector<HTMLElement>(
      '[data-viewer-owner-segment]',
    )!
    const separator = segment.querySelector<HTMLElement>(
      'span[aria-hidden="true"]',
    )!
    const name = Array.from(segment.querySelectorAll('span')).find(
      (el) => el.textContent === ownerName,
    )!
    expect(name.scrollWidth).toBeGreaterThan(name.clientWidth)
    expect(await visibleWidth(separator)).toBeGreaterThan(0)
    expect(await visibleWidth(name)).toBeGreaterThan(0)
    expect(
      fits(segment.getBoundingClientRect().width, await visibleWidth(segment)),
    ).toBe(true)
    expect(await visibleWidth(entryButton())).toBeGreaterThan(0)
  })

  it('keeps the open panel content and state across desktop and phone resizes', async () => {
    await page.viewport(1280, 800)
    await renderHarness()
    entryButton().click()
    // Wait for the fetched rows to render.
    const findRow = () =>
      Array.from(document.querySelectorAll('[title]')).find(
        (el) => el.getAttribute('title') === 'Alice Cooper',
      )
    await vi.waitFor(() => {
      expect(findRow()).toBeDefined()
    })
    expect(viewerFetchCount).toBe(1)
    const rowBefore = findRow()

    await page.viewport(390, 844)
    // The panel presentation switches via CSS only — no JS breakpoint —
    // so the same DOM nodes remain mounted and no refetch happens.
    expect(findRow()).toBe(rowBefore)
    expect(entryButton().getAttribute('aria-expanded')).toBe('true')
    expect(viewerFetchCount).toBe(1)

    await page.viewport(1280, 800)
    expect(findRow()).toBe(rowBefore)
    expect(entryButton().getAttribute('aria-expanded')).toBe('true')
    expect(viewerFetchCount).toBe(1)
  })
})
