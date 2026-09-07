// Browser mode cannot load a test module from the route directory whose name
// contains `$`, so this behavior test lives one level above the components.
import { createRoot, type Root } from 'react-dom/client'
import { StrictMode } from 'react'
import { MemoryRouter } from 'react-router'
import { toast } from 'sonner'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { cdp, page } from 'vitest/browser'
import '~/app.css'
import { TooltipProvider } from '~/components/ui/tooltip'
import { Toaster } from '~/components/ui/sonner'
import { waitForBrowserLayout } from '~/test/browser-layout'
import { CommentMessageItem } from './a.$id/+components/comment-message-item'
import { ViewerChrome } from './a.$id/+components/viewer-chrome'

vi.mock('~/hooks/use-t', async () => {
  const { bindI18n } = await import('~/lib/i18n')
  return { useT: () => bindI18n('en') }
})

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
    commentPanelOpen: false,
    openBanner: () => {},
    setCommentPanelOpen: () => {},
  }),
}))

vi.mock('./a.$id/+components/visibility-dialog', () => ({
  VisibilityDialog: ({
    open,
    onOpenChange,
  }: {
    open: boolean
    onOpenChange: (open: boolean) => void
  }) =>
    open ? (
      <div role="dialog" aria-label="Sharing settings">
        <button type="button" onClick={() => onOpenChange(false)}>
          Close sharing settings
        </button>
      </div>
    ) : null,
}))

const artifact = {
  id: 'abc123def4',
  storageKey: 'abc123def4/index.html',
  name: 'demo.html',
  derivedTitle: 'Demo',
  titleOverride: null,
  ownerId: 'owner-1',
  ownerName: 'Owner',
  ownerEmail: 'owner@example.com',
  ownerImage: null,
  ownerInitial: 'O',
  modifiedTime: '2026-08-01T00:00:00.000Z',
  viewCount: 7,
  canReplaceFile: false,
  canViewHistory: false,
  canChangeVisibility: true,
  visibility: 'private' as const,
  availableVisibilities: ['private', 'link'] as const,
  grants: [],
}

const owner = {
  id: 'owner-1',
  email: 'owner@example.com',
  name: 'Owner',
  image: null,
  initial: 'O',
}

describe('sharing recovery browser behavior', () => {
  let root: Root
  let host: HTMLDivElement
  let clipboardDescriptor: PropertyDescriptor | undefined
  let execCommandDescriptor: PropertyDescriptor | undefined
  let originalUrl: string

  beforeEach(() => {
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    originalUrl = window.location.href
    clipboardDescriptor = Object.getOwnPropertyDescriptor(
      navigator,
      'clipboard',
    )
    execCommandDescriptor = Object.getOwnPropertyDescriptor(
      document,
      'execCommand',
    )
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn().mockRejectedValue(new Error('denied')) },
    })
    Object.defineProperty(document, 'execCommand', {
      configurable: true,
      value: vi.fn(() => false),
    })
  })

  afterEach(() => {
    toast.dismiss()
    root.unmount()
    host.remove()
    window.history.replaceState({}, '', originalUrl)
    if (clipboardDescriptor) {
      Object.defineProperty(navigator, 'clipboard', clipboardDescriptor)
    } else {
      Reflect.deleteProperty(navigator, 'clipboard')
    }
    if (execCommandDescriptor) {
      Object.defineProperty(document, 'execCommand', execCommandDescriptor)
    } else {
      Reflect.deleteProperty(document, 'execCommand')
    }
  })

  function renderViewer(
    user: typeof owner | null,
    nextArtifact = artifact,
    showViewer = true,
  ) {
    root.render(
      <StrictMode>
        <MemoryRouter initialEntries={['/a/abc123def4?version=v1']}>
          <TooltipProvider>
            {showViewer ? (
              <ViewerChrome
                artifact={nextArtifact}
                user={user}
                renderType="html"
                collapsible={false}
              />
            ) : null}
            <Toaster position="bottom-center" />
          </TooltipProvider>
        </MemoryRouter>
      </StrictMode>,
    )
  }

  test('keeps the exact failed URL selectable through sharing dialog recovery', async () => {
    await page.viewport(390, 600)
    const historicalVersion = `v1-${'long-version-segment-'.repeat(3)}`
    window.history.replaceState(
      {},
      '',
      `/a/abc123def4?version=${historicalVersion}&access-request=request-1#note`,
    )
    const failedUrl = new URL(window.location.href)
    failedUrl.searchParams.delete('access-request')
    renderViewer(owner)

    await vi.waitFor(() =>
      expect(host.querySelector('[aria-label="Copy link"]')).not.toBeNull(),
    )
    host.querySelector<HTMLButtonElement>('[aria-label="Copy link"]')?.click()

    await vi.waitFor(() =>
      expect(document.querySelector('[data-sonner-toast]')).not.toBeNull(),
    )
    const recoveryToast = document.querySelector<HTMLElement>(
      '[data-sonner-toast]',
    )
    await vi.waitFor(() => expect(recoveryToast?.dataset.mounted).toBe('true'))
    await new Promise((resolve) => window.setTimeout(resolve, 450))
    expect(recoveryToast?.textContent).toContain(failedUrl.toString())
    expect(getComputedStyle(recoveryToast!).userSelect).toBe('text')
    await dragSelectToastText(recoveryToast!)
    expect(window.getSelection()?.toString()).toContain(failedUrl.toString())

    host.querySelector<HTMLButtonElement>('[aria-label="Copy link"]')?.click()
    await vi.waitFor(() =>
      expect(document.querySelectorAll('[data-sonner-toast]')).toHaveLength(1),
    )

    document.querySelector<HTMLButtonElement>('[data-button]')?.click()
    await vi.waitFor(() =>
      expect(host.querySelector('[role="dialog"]')).not.toBeNull(),
    )
    expect(document.querySelector('[data-sonner-toast]')).toBe(recoveryToast)
    host.querySelector<HTMLButtonElement>('[role="dialog"] button')?.click()
    await vi.waitFor(() =>
      expect(host.querySelector('[role="dialog"]')).toBeNull(),
    )

    await new Promise((resolve) => window.setTimeout(resolve, 4_300))
    expect(document.querySelector('[data-sonner-toast]')).toBe(recoveryToast)

    document.querySelector<HTMLButtonElement>('[data-close-button]')?.click()
    await vi.waitFor(() =>
      expect(document.querySelector('[data-sonner-toast]')).toBeNull(),
    )
  }, 10_000)

  test('does not expose sharing settings to an anonymous caller', async () => {
    renderViewer(null)
    await vi.waitFor(() =>
      expect(host.querySelector('[aria-label="Copy link"]')).not.toBeNull(),
    )
    host.querySelector<HTMLButtonElement>('[aria-label="Copy link"]')?.click()

    await vi.waitFor(() =>
      expect(document.querySelector('[data-sonner-toast]')).not.toBeNull(),
    )
    expect(document.querySelector('[data-button]')).toBeNull()
    expect(host.querySelector('[role="dialog"]')).toBeNull()
  })

  test('retires stale actions across target, permission, and mount lifecycles', async () => {
    window.history.replaceState({}, '', '/a/abc123def4')
    renderViewer(owner)
    await waitForBrowserLayout()
    host.querySelector<HTMLButtonElement>('[aria-label="Copy link"]')?.click()
    await vi.waitFor(() =>
      expect(document.querySelector('[data-button]')).not.toBeNull(),
    )
    const firstToast = document.querySelector<HTMLElement>(
      '[data-sonner-toast]',
    )!
    const firstUrl = window.location.href

    const secondArtifact = { ...artifact, id: 'second-file' }
    renderViewer(owner, secondArtifact)
    await vi.waitFor(() =>
      expect(document.querySelector('[data-button]')).toBeNull(),
    )
    expect(firstToast.textContent).toContain(firstUrl)

    await waitForBrowserLayout()
    host.querySelector<HTMLButtonElement>('[aria-label="Copy link"]')?.click()
    await vi.waitFor(() =>
      expect(document.querySelector('[data-button]')).not.toBeNull(),
    )
    renderViewer(owner, { ...secondArtifact, canChangeVisibility: false })
    await vi.waitFor(() =>
      expect(document.querySelector('[data-button]')).toBeNull(),
    )

    renderViewer(owner, secondArtifact)
    await waitForBrowserLayout()
    host.querySelector<HTMLButtonElement>('[aria-label="Copy link"]')?.click()
    await vi.waitFor(() =>
      expect(document.querySelector('[data-button]')).not.toBeNull(),
    )
    renderViewer(owner, secondArtifact, false)
    await vi.waitFor(() =>
      expect(document.querySelector('[data-button]')).toBeNull(),
    )
    expect(firstToast.textContent).toContain(firstUrl)
  })
})

async function dragSelectToastText(recoveryToast: HTMLElement) {
  const title = recoveryToast.querySelector<HTMLElement>('[data-title]')!
  const textRange = document.createRange()
  textRange.selectNodeContents(title)
  const lineRects = Array.from(textRange.getClientRects())
  expect(lineRects.length).toBeGreaterThan(1)
  const firstLine = lineRects[0]!
  const lastLine = lineRects.at(-1)!
  const frameOffset = { x: 0, y: 0 }
  let currentWindow: Window = window
  while (currentWindow.frameElement) {
    const frameRect = currentWindow.frameElement.getBoundingClientRect()
    frameOffset.x += frameRect.x
    frameOffset.y += frameRect.y
    currentWindow = currentWindow.parent
  }
  const start = {
    x: frameOffset.x + firstLine.x + 2,
    y: frameOffset.y + firstLine.y + firstLine.height / 2,
  }
  const end = {
    x: frameOffset.x + lastLine.right - 2,
    y: frameOffset.y + lastLine.y + lastLine.height / 2,
  }
  const cdpSession = cdp() as {
    send(method: string, params: Record<string, unknown>): Promise<unknown>
  }
  await cdpSession.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    ...start,
  })
  await cdpSession.send('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    ...start,
    button: 'left',
    clickCount: 1,
  })
  for (let step = 1; step <= 8; step += 1) {
    await cdpSession.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: start.x + ((end.x - start.x) * step) / 8,
      y: start.y + ((end.y - start.y) * step) / 8,
      button: 'left',
      buttons: 1,
    })
  }
  await cdpSession.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    ...end,
    button: 'left',
    clickCount: 1,
  })
}

describe('comment author layout', () => {
  let root: Root
  let host: HTMLDivElement

  beforeEach(() => {
    host = document.createElement('div')
    host.style.width = '300px'
    document.body.appendChild(host)
    root = createRoot(host)
  })

  afterEach(() => {
    root.unmount()
    host.remove()
  })

  test('prioritizes a long author identity and wraps secondary metadata', async () => {
    root.render(
      <CommentMessageItem
        message={{
          id: 'message-1',
          body: 'A review comment.',
          agent: 'Long-running review agent',
          createdAt: '2026-08-01T00:00:00.000Z',
          updatedAt: '2026-08-02T00:00:00.000Z',
          author: {
            id: 'author-1',
            name: 'Alexandria Montgomery-Worthington the Third',
            email: 'alexandria@example.com',
            image: null,
            kind: 'bot',
          },
          canEdit: true,
          canDelete: true,
        }}
        locale="en"
        pending={false}
        onUpdate={() => Promise.resolve(true)}
        onDelete={() => Promise.resolve(true)}
      />,
    )
    await waitForBrowserLayout()

    const identity = host.querySelector<HTMLElement>(
      '[data-comment-author-identity]',
    )!
    const metadata = host.querySelector<HTMLElement>(
      '[data-comment-message-meta]',
    )!
    expect(identity.getBoundingClientRect().width).toBeGreaterThanOrEqual(190)
    expect(metadata.getBoundingClientRect().top).toBeGreaterThanOrEqual(
      identity.getBoundingClientRect().bottom - 1,
    )
    expect(host.scrollWidth).toBeLessThanOrEqual(host.clientWidth)
  })
})
