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
  AvatarMenu: () => <button type="button">Account</button>,
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
    },
    {
      userId: 'viewer-2',
      name: 'Alice Cooper',
      image: null,
      lastViewedAt: '2026-08-16T00:00:00.000Z',
      isSelf: false,
    },
  ],
  nextCursor: null,
  totalViewers: 2,
}

// ViewerShell の閲覧者リスト部分と同じ配線 (reducer + useViewerList + 実 chrome
// + 実パネル) を持つ harness。browser テストで検証するのは CSS 挙動 (390px
// 非クリッピング / リサイズ維持) で、フル shell の配線自体は happy-dom テスト
// (viewer-list-wiring.test.tsx) が担う。
function Harness() {
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
        artifact={artifact}
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

  async function renderHarness() {
    root.render(
      <MemoryRouter initialEntries={['/a/s1']}>
        <Harness />
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
    const button = entryButton()
    expect(button.scrollWidth).toBeLessThanOrEqual(button.clientWidth)
    const rect = button.getBoundingClientRect()
    expect(rect.right).toBeLessThanOrEqual(390)
    expect(rect.width).toBeGreaterThan(0)
  })

  it('never leaves the owner separator as an orphan at a 390px viewport', async () => {
    await page.viewport(390, 844)
    await renderHarness()
    const segment = container.querySelector<HTMLElement>(
      '[data-viewer-owner-segment]',
    )
    expect(segment).not.toBeNull()
    const separator = segment!.querySelector<HTMLElement>(
      'span[aria-hidden="true"]',
    )
    expect(separator).not.toBeNull()
    const name = Array.from(segment!.querySelectorAll('span')).find(
      (el) => el.textContent === artifact.ownerName,
    )
    expect(name).toBeDefined()
    // The separator shares the owner segment's clipping container, so it can
    // only be visible when some owner content is visible too — it must never
    // remain as a dangling "·" after the owner segment collapses.
    const segmentRect = segment!.getBoundingClientRect()
    const separatorRect = separator!.getBoundingClientRect()
    const visibleWidth = (rect: DOMRect) =>
      Math.max(
        0,
        Math.min(rect.right, segmentRect.right) -
          Math.max(rect.left, segmentRect.left),
      )
    if (visibleWidth(separatorRect) > 0) {
      const nameRect = name!.getBoundingClientRect()
      expect(visibleWidth(nameRect)).toBeGreaterThan(0)
    }
    // The segment itself stays within the viewport.
    expect(segmentRect.right).toBeLessThanOrEqual(390)
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
