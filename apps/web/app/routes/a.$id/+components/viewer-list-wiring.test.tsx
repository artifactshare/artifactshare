// @vitest-environment happy-dom
import React from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { createRoutesStub, Outlet, useLocation } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode, RefObject } from 'react'
import { ViewerShell, type ViewerShellArtifact } from './viewer-shell'
import { ViewerListPanel } from './viewer-list-panel'

vi.mock('~/components/ui/sheet', () => ({
  Sheet: ({
    open,
    children,
  }: {
    open?: boolean
    children?: ReactNode
    modal?: boolean
    onOpenChange?: (open: boolean) => void
  }) => (
    <div data-sheet data-open={String(open === true)}>
      {open ? children : null}
    </div>
  ),
  SheetContent: ({ children }: { children?: ReactNode }) => (
    <div>{children}</div>
  ),
  SheetHeader: ({ children }: { children?: ReactNode }) => (
    <div>{children}</div>
  ),
  SheetTitle: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  SheetClose: ({ children }: { children?: ReactNode }) => <>{children}</>,
}))

vi.mock('./comment-panel', () => ({
  CommentPanel: ({ open }: { open: boolean }) => (
    <div data-testid="comment-panel" data-open={String(open)} />
  ),
}))

vi.mock('./sandbox-frame', () => ({
  SandboxFrame: ({ children }: { children?: ReactNode }) => (
    <div data-testid="sandbox-frame">{children}</div>
  ),
}))

vi.mock('./history-panel', () => ({
  HistoryPanel: ({ open }: { open: boolean }) => (
    <div data-testid="history-panel" data-open={String(open)} />
  ),
  VersionWidget: ({
    onOpenHistory,
    onCommentsOpen,
  }: {
    onOpenHistory?: (returnFocusTo?: HTMLElement | null) => void
    onCommentsOpen?: (returnFocusTo?: HTMLElement | null) => void
  }) => (
    <div>
      <button
        type="button"
        data-testid="widget-open-history"
        onClick={() => onOpenHistory?.(null)}
      />
      <button
        type="button"
        data-testid="widget-open-comments"
        onClick={() => onCommentsOpen?.(null)}
      />
    </div>
  ),
}))

vi.mock('./inline-comment-popover', () => ({
  InlineCommentPopover: ({
    onOpenConversation,
  }: {
    onOpenConversation?: (threadId: string) => void
  }) => (
    <button
      type="button"
      data-testid="inline-open-conversation"
      onClick={() => onOpenConversation?.('thread-1')}
    />
  ),
}))

vi.mock('~/components/ui/dropdown-menu', () => ({
  DropdownMenu: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  DropdownMenuTrigger: ({ children }: { children: ReactNode }) => (
    <>{children}</>
  ),
  DropdownMenuContent: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  DropdownMenuItem: ({
    children,
    onSelect,
    ...props
  }: {
    children: ReactNode
    onSelect?: (event: Event) => void
  } & Record<string, unknown>) => (
    <button
      type="button"
      {...props}
      onClick={() => onSelect?.(new Event('select'))}
    >
      {children}
    </button>
  ),
  DropdownMenuLabel: ({ children }: { children: ReactNode }) => (
    <span>{children}</span>
  ),
  DropdownMenuSeparator: () => <hr />,
}))

vi.mock('~/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: () => null,
}))

vi.mock('~/components/app/avatar-menu', () => ({
  AvatarMenu: ({
    onAccessRequestsOpen,
    accessRequestsOpen,
    onAccessRequestsOpenChange,
  }: {
    onAccessRequestsOpen?: () => void
    accessRequestsOpen?: boolean
    onAccessRequestsOpenChange?: (open: boolean) => void
  }) => (
    <div data-testid="access-requests" data-open={String(accessRequestsOpen)}>
      <button
        type="button"
        data-testid="open-access-requests"
        onClick={() => {
          onAccessRequestsOpen?.()
          onAccessRequestsOpenChange?.(true)
        }}
      >
        Account
      </button>
    </div>
  ),
}))

vi.mock('~/components/app/analytics-consent-provider', () => ({
  useAnalyticsConsent: () => ({
    openBanner: vi.fn(),
    setCommentPanelOpen: vi.fn(),
  }),
}))

class FakeWebSocket {
  static OPEN = 1
  readyState = 0
  addEventListener() {}
  removeEventListener() {}
  send() {}
  close() {}
}

function artifactFixture(id = 's1'): ViewerShellArtifact {
  return {
    id,
    storageKey: `${id}/index.html`,
    name: 'demo.html',
    derivedTitle: 'Demo',
    titleOverride: null,
    ownerId: 'owner-1',
    ownerName: 'Owner',
    ownerEmail: 'owner@example.com',
    ownerImage: null,
    ownerInitial: 'O',
    modifiedTime: null,
    viewCount: 7,
    canReplaceFile: false,
    canViewHistory: true,
    canChangeVisibility: false,
    currentVersionId: 'v1',
    versions: [],
    comments: [],
    showViewerListMetaEntry: true,
    viewerListCount: 2,
  }
}

const user = {
  id: 'viewer-1',
  email: 'viewer@example.com',
  name: 'Viewer',
  image: null,
  initial: 'V',
}

function LocationProbe() {
  const location = useLocation()
  return <output data-testid="location-search">{location.search}</output>
}

describe('viewer list wiring in ViewerShell', () => {
  let root: Root
  let container: HTMLDivElement
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    fetchMock = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          resolve(
            new Response(
              JSON.stringify({
                viewers: [],
                nextCursor: null,
                totalViewers: 0,
              }),
              {
                status: 200,
                headers: { 'content-type': 'application/json' },
              },
            ),
          )
        }),
    )
    vi.stubGlobal('fetch', fetchMock)
    vi.stubGlobal('WebSocket', FakeWebSocket)
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    root.unmount()
    container.remove()
    vi.unstubAllGlobals()
  })

  function renderShell({
    artifact = artifactFixture(),
    initialEntry = `/a/${artifact.id}`,
  }: {
    artifact?: ViewerShellArtifact
    initialEntry?: string
  } = {}) {
    const Stub = createRoutesStub([
      {
        id: 'root',
        path: '/',
        loader: () => ({ locale: 'en' }),
        Component: () => (
          <>
            <LocationProbe />
            <Outlet />
          </>
        ),
        children: [
          {
            path: 'a/:id',
            Component: () => (
              <ViewerShell
                artifact={artifact}
                user={user}
                renderType="html"
                sandboxUrl="https://sandbox.example/frame"
                bundlePaths={[]}
              />
            ),
          },
        ],
      },
    ])
    return React.act(async () => {
      root.render(<Stub initialEntries={[initialEntry]} />)
    })
  }

  function entryButton(): HTMLButtonElement {
    const button = container.querySelector<HTMLButtonElement>(
      '[data-viewer-list-entry]',
    )
    if (!button) throw new Error('viewer list entry button not found')
    return button
  }

  function viewerListSheet(): HTMLElement {
    const sheet = container.querySelector<HTMLElement>('[data-sheet]')
    if (!sheet) throw new Error('viewer list sheet not found')
    return sheet
  }

  function commentPanel(): HTMLElement {
    const panel = container.querySelector<HTMLElement>(
      '[data-testid="comment-panel"]',
    )
    if (!panel) throw new Error('comment panel stub not found')
    return panel
  }

  function historyPanel(): HTMLElement {
    const panel = container.querySelector<HTMLElement>(
      '[data-testid="history-panel"]',
    )
    if (!panel) throw new Error('history panel stub not found')
    return panel
  }

  function click(element: HTMLElement) {
    return React.act(async () => {
      element.click()
    })
  }

  it('meta entry toggles the panel and aria-expanded follows the open state', async () => {
    await renderShell()
    expect(entryButton().getAttribute('aria-expanded')).toBe('false')
    await click(entryButton())
    expect(viewerListSheet().dataset.open).toBe('true')
    expect(entryButton().getAttribute('aria-expanded')).toBe('true')
    await click(entryButton())
    expect(viewerListSheet().dataset.open).toBe('false')
    expect(entryButton().getAttribute('aria-expanded')).toBe('false')
  })

  it('menu item opens the panel and aria-expanded is origin independent', async () => {
    await renderShell()
    const menuItem = container.querySelector<HTMLButtonElement>(
      '[data-viewer-list-menu-item]',
    )
    expect(menuItem).not.toBeNull()
    await click(menuItem!)
    expect(viewerListSheet().dataset.open).toBe('true')
    expect(entryButton().getAttribute('aria-expanded')).toBe('true')
    // Clicking the meta entry while open (from the menu) closes the panel.
    await click(entryButton())
    expect(viewerListSheet().dataset.open).toBe('false')
  })

  it('fetches the list on each open and not while closed', async () => {
    await renderShell()
    const viewerCalls = () =>
      fetchMock.mock.calls.filter((call) =>
        String(call[0]).includes('/viewers'),
      ).length
    expect(viewerCalls()).toBe(0)
    await click(entryButton())
    expect(viewerCalls()).toBe(1)
    await click(entryButton())
    await click(entryButton())
    expect(viewerCalls()).toBe(2)
  })

  it('opening comments from the topbar closes the viewer list', async () => {
    await renderShell()
    await click(entryButton())
    expect(viewerListSheet().dataset.open).toBe('true')
    const commentsButton = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Comments"]',
    )
    expect(commentsButton).not.toBeNull()
    await click(commentsButton!)
    expect(commentPanel().dataset.open).toBe('true')
    expect(viewerListSheet().dataset.open).toBe('false')
  })

  it('opening the viewer list closes the comment panel (bidirectional)', async () => {
    await renderShell()
    const commentsButton = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Comments"]',
    )
    await click(commentsButton!)
    expect(commentPanel().dataset.open).toBe('true')
    await click(entryButton())
    expect(viewerListSheet().dataset.open).toBe('true')
    expect(commentPanel().dataset.open).toBe('false')
  })

  it('a comment deep link opens comments, and reopening the viewer list closes them', async () => {
    await renderShell({ initialEntry: '/a/s1?comment=thread-1' })
    expect(commentPanel().dataset.open).toBe('true')
    await click(entryButton())
    expect(commentPanel().dataset.open).toBe('false')
    expect(viewerListSheet().dataset.open).toBe('true')
  })

  it('opening comments from the version widget closes the viewer list', async () => {
    await renderShell()
    await click(entryButton())
    await click(
      container.querySelector<HTMLButtonElement>(
        '[data-testid="widget-open-comments"]',
      )!,
    )
    expect(commentPanel().dataset.open).toBe('true')
    expect(viewerListSheet().dataset.open).toBe('false')
  })

  it('opening the conversation from the inline popover closes the viewer list', async () => {
    await renderShell()
    await click(entryButton())
    await click(
      container.querySelector<HTMLButtonElement>(
        '[data-testid="inline-open-conversation"]',
      )!,
    )
    expect(commentPanel().dataset.open).toBe('true')
    expect(viewerListSheet().dataset.open).toBe('false')
  })

  it('opening history from the version widget closes the viewer list', async () => {
    await renderShell()
    await click(entryButton())
    await click(
      container.querySelector<HTMLButtonElement>(
        '[data-testid="widget-open-history"]',
      )!,
    )
    expect(historyPanel().dataset.open).toBe('true')
    expect(viewerListSheet().dataset.open).toBe('false')
  })

  it('opening access requests closes every viewer side panel', async () => {
    await renderShell()
    const commentsButton = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Comments"]',
    )!
    await click(commentsButton)
    expect(commentPanel().dataset.open).toBe('true')

    await click(
      container.querySelector<HTMLButtonElement>(
        '[data-testid="open-access-requests"]',
      )!,
    )
    expect(commentPanel().dataset.open).toBe('false')
    expect(historyPanel().dataset.open).toBe('false')
    expect(viewerListSheet().dataset.open).toBe('false')
  })

  it('opening another viewer panel closes access requests', async () => {
    await renderShell()
    const accessRequests = container.querySelector<HTMLElement>(
      '[data-testid="access-requests"]',
    )!
    await click(
      container.querySelector<HTMLButtonElement>(
        '[data-testid="open-access-requests"]',
      )!,
    )
    expect(accessRequests.dataset.open).toBe('true')

    await click(
      container.querySelector<HTMLButtonElement>(
        'button[aria-label="Comments"]',
      )!,
    )
    expect(commentPanel().dataset.open).toBe('true')
    expect(accessRequests.dataset.open).toBe('false')
  })

  it('clears an access-request deep link when another panel opens', async () => {
    await renderShell({ initialEntry: '/a/s1?access-request=request-1' })
    const accessRequests = container.querySelector<HTMLElement>(
      '[data-testid="access-requests"]',
    )!
    expect(accessRequests.dataset.open).toBe('true')

    await click(
      container.querySelector<HTMLButtonElement>(
        'button[aria-label="Comments"]',
      )!,
    )

    expect(accessRequests.dataset.open).toBe('false')
    expect(
      container.querySelector('[data-testid="location-search"]')?.textContent,
    ).toBe('')
  })

  it('returns focus to the meta entry when the panel closes', async () => {
    await renderShell()
    await click(entryButton())
    expect(viewerListSheet().dataset.open).toBe('true')
    await click(entryButton())
    expect(document.activeElement).toBe(entryButton())
  })

  it('does not steal focus when opening comments force-closes the panel', async () => {
    await renderShell()
    await click(entryButton())
    expect(viewerListSheet().dataset.open).toBe('true')
    const commentsButton = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Comments"]',
    )
    expect(commentsButton).not.toBeNull()
    // The comments flow moves focus (here: to the trigger, standing in for
    // wherever the opening panel puts it); the forced close must leave it.
    await React.act(async () => {
      commentsButton!.focus()
      commentsButton!.click()
    })
    expect(commentPanel().dataset.open).toBe('true')
    expect(viewerListSheet().dataset.open).toBe('false')
    expect(document.activeElement).toBe(commentsButton)
    expect(document.activeElement).not.toBe(entryButton())
  })

  it('does not steal focus when opening history force-closes the panel', async () => {
    await renderShell()
    await click(entryButton())
    const historyButton = container.querySelector<HTMLButtonElement>(
      '[data-testid="widget-open-history"]',
    )
    expect(historyButton).not.toBeNull()
    await React.act(async () => {
      historyButton!.focus()
      historyButton!.click()
    })
    expect(historyPanel().dataset.open).toBe('true')
    expect(viewerListSheet().dataset.open).toBe('false')
    expect(document.activeElement).toBe(historyButton)
    expect(document.activeElement).not.toBe(entryButton())
  })

  it('skips focus return while the chrome is collapsed', async () => {
    await renderShell()
    await click(entryButton())
    const collapseToggle = container.querySelector<HTMLButtonElement>(
      'button[aria-controls="viewer-topbar"]',
    )
    expect(collapseToggle).not.toBeNull()
    await click(collapseToggle!)
    await click(entryButton())
    expect(viewerListSheet().dataset.open).toBe('false')
    expect(document.activeElement).not.toBe(entryButton())
  })
})

describe('ViewerListPanel focus return', () => {
  let root: Root
  let container: HTMLDivElement

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    root.unmount()
    container.remove()
  })

  let setOpen: (open: boolean) => void

  function mountPanel(
    returnFocusRef: RefObject<HTMLElement | null>,
    closeReason?: 'user' | 'forced' | null,
  ) {
    function Harness() {
      const [open, set] = React.useState(true)
      setOpen = set
      return (
        <ViewerListPanel
          open={open}
          onOpenChange={set}
          rows={[]}
          totalViewers={0}
          status="loaded"
          loadingMore={false}
          nextCursor={null}
          onLoadMore={() => {}}
          onRetry={() => {}}
          returnFocusRef={returnFocusRef}
          closeReason={open ? null : closeReason}
        />
      )
    }
    const Stub = createRoutesStub([
      {
        id: 'root',
        path: '/',
        loader: () => ({ locale: 'en' }),
        Component: Harness,
      },
    ])
    return React.act(async () => {
      root.render(<Stub initialEntries={['/']} />)
    })
  }

  function closePanel() {
    return React.act(async () => {
      setOpen(false)
    })
  }

  it('returns focus to a connected trigger element', async () => {
    const trigger = document.createElement('button')
    document.body.appendChild(trigger)
    const ref = { current: trigger as HTMLElement | null }
    await mountPanel(ref)
    await closePanel()
    expect(document.activeElement).toBe(trigger)
    trigger.remove()
  })

  it('skips focus return on a forced close (exclusivity / artifact switch)', async () => {
    const trigger = document.createElement('button')
    document.body.appendChild(trigger)
    const ref = { current: trigger as HTMLElement | null }
    await mountPanel(ref, 'forced')
    await closePanel()
    expect(document.activeElement).not.toBe(trigger)
    trigger.remove()
  })

  it('skips focus return when the trigger is no longer connected', async () => {
    const trigger = document.createElement('button')
    // Never attached to the document: simulates the artifact-switch case
    // where the recorded trigger has been unmounted.
    const ref = { current: trigger as HTMLElement | null }
    await mountPanel(ref)
    await closePanel()
    expect(document.activeElement).not.toBe(trigger)
  })
})
