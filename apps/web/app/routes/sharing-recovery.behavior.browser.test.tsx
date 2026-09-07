// Browser mode cannot load a test module from the route directory whose name
// contains `$`, so this behavior test lives one level above the components.
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter } from 'react-router'
import { toast } from 'sonner'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
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

  beforeEach(() => {
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
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

  function renderViewer(user: typeof owner | null) {
    root.render(
      <MemoryRouter initialEntries={['/a/abc123def4?version=v1']}>
        <TooltipProvider>
          <ViewerChrome
            artifact={artifact}
            user={user}
            renderType="html"
            collapsible={false}
          />
          <Toaster position="bottom-center" />
        </TooltipProvider>
      </MemoryRouter>,
    )
  }

  test('keeps the exact failed URL selectable through sharing dialog recovery', async () => {
    window.history.replaceState(
      {},
      '',
      '/a/abc123def4?version=v1&access-request=request-1#note',
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
    expect(recoveryToast?.textContent).toContain(failedUrl.toString())
    expect(getComputedStyle(recoveryToast!).userSelect).toBe('text')
    const selection = window.getSelection()
    const range = document.createRange()
    range.selectNodeContents(recoveryToast!)
    selection?.removeAllRanges()
    selection?.addRange(range)
    expect(selection?.toString()).toContain(failedUrl.toString())

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
})

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
