import { renderToStaticMarkup } from 'react-dom/server'
import type { AnchorHTMLAttributes, ComponentProps, ReactNode } from 'react'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { TooltipProvider } from '~/components/ui/tooltip'
import { ViewerChrome } from './viewer-chrome'

vi.mock('~/hooks/use-hydrated', () => ({
  useHydrated: () => true,
}))

vi.mock('~/hooks/use-t', () => ({
  useT: () => ({
    locale: 'en',
    t: (key: string, vars?: Record<string, string | number>) =>
      ({
        'vw.back': 'Back',
        'vw.homeLink': 'Artifact Share home',
        'vw.copyUrl': 'Copy URL',
        'vw.more': 'More',
        'vw.versionHistory': 'History & add new version',
        'vw.versionHistoryReadonly': 'Version history',
        'vw.changeVisibility': 'Change visibility',
        'table.visibilityPrivate': 'Specific',
        'vw.exportGroup': 'Export',
        'vw.copyMarkdown': 'Copy Markdown',
        'vw.downloadHtml': 'Download HTML',
        'vw.downloadMarkdown': 'Download Markdown',
        'vw.downloadPdf': 'Download PDF',
        'vw.move': 'Move to another place',
        'vw.collapseChrome': 'Collapse Artifact Share',
        'vw.expandChrome': 'Show Artifact Share',
        'vw.editTitleLabel': `Edit title: ${vars?.title ?? ''}`,
        'vw.editTitleInputLabel': 'Artifact title',
        'vw.titleEditPlaceholder':
          'Save empty to restore the auto-extracted title',
        'upload.visibility.private': 'Only invited people',
        'menu.remove': 'Remove',
      })[key] ?? key,
    tPlural: (key: string, n: number) =>
      key === 'card.viewCount' ? `${n} views` : `${n}`,
  }),
}))

let mockLocationState: unknown = null

vi.mock('react-router', () => ({
  Link: ({
    children,
    to,
    replace: _replace,
    viewTransition: _viewTransition,
    state: _state,
    ...props
  }: AnchorHTMLAttributes<HTMLAnchorElement> & {
    children: ReactNode
    to: string
    replace?: boolean
    viewTransition?: boolean
    state?: unknown
  }) => (
    <a href={to} {...props}>
      {children}
    </a>
  ),
  useLocation: () => ({ state: mockLocationState }),
  useRevalidator: () => ({ revalidate: vi.fn() }),
}))

vi.mock('~/components/app/avatar-menu', () => ({
  AvatarMenu: () => <button type="button">Account</button>,
}))

vi.mock('~/components/ui/dropdown-menu', () => ({
  DropdownMenu: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  DropdownMenuTrigger: ({ children }: { children: ReactNode }) => (
    <>{children}</>
  ),
  DropdownMenuContent: ({ children }: { children: ReactNode }) => (
    <div className="dropdown-menu-content">{children}</div>
  ),
  DropdownMenuItem: ({
    children,
    onSelect,
    className,
  }: {
    children: ReactNode
    onSelect?: (event: Event) => void
    className?: string
  }) => (
    <button
      type="button"
      className={className}
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

vi.mock('./visibility-dialog', () => ({
  VisibilityDialog: () => null,
}))

vi.mock('../+hooks/use-remove-artifact', () => ({
  useRemoveArtifact: () => vi.fn(),
}))

vi.mock('../+hooks/use-edit-title', () => ({
  useEditTitle: () => ({
    isEditing: false,
    value: 'Demo',
    start: vi.fn(),
    change: vi.fn(),
    submit: vi.fn(),
    cancel: vi.fn(),
  }),
}))

function renderChrome(props: ComponentProps<typeof ViewerChrome>) {
  return renderToStaticMarkup(
    <TooltipProvider>
      <ViewerChrome {...props} />
    </TooltipProvider>,
  )
}

describe('ViewerChrome', () => {
  beforeEach(() => {
    mockLocationState = null
  })

  test('anonymous viewer shows home link but no back link', () => {
    mockLocationState = null

    const html = renderChrome({
      artifact,
      user: null,
      renderType: 'html',
      collapsible: false,
    })

    expect(html).toContain('aria-label="Artifact Share home"')
    expect(html).toContain('>Artifact Share<')
    expect(html).not.toContain('aria-label="Back"')
  })

  test('renders the editable title as the page heading and a named button', () => {
    const html = renderChrome({
      artifact,
      user: {
        id: 'u1',
        email: 'coji@example.com',
        name: 'Coji',
        image: null,
        initial: 'C',
      },
      renderType: 'html',
    })

    expect(html).toContain('<h1 id="viewer-heading"')
    expect(html).toContain('aria-label="Edit title: Demo"')
    expect(html).toContain('7 views')
    expect(html).not.toContain('role="button"')
  })

  test('expanded chrome toggle is a single collapse control', () => {
    const html = renderChrome({
      artifact,
      user: {
        id: 'u1',
        email: 'coji@example.com',
        name: 'Coji',
        image: null,
        initial: 'C',
      },
      renderType: 'html',
      collapsed: false,
    })

    expect(html).toContain('aria-expanded="true"')
    expect(html).toContain('aria-label="Collapse Artifact Share"')
    expect(html).toContain('aria-controls="viewer-topbar"')
  })

  test('collapsed chrome toggle expands the topbar and shows brand label', () => {
    const html = renderChrome({
      artifact,
      user: {
        id: 'u1',
        email: 'coji@example.com',
        name: 'Coji',
        image: null,
        initial: 'C',
      },
      renderType: 'html',
      collapsed: true,
    })

    expect(html).toContain('aria-expanded="false"')
    expect(html).toContain('aria-label="Show Artifact Share"')
    expect(html).toContain('>Artifact Share<')
  })

  test('logged-in user sees export actions in the more menu', () => {
    const html = renderChrome({
      artifact,
      user: {
        id: 'u1',
        email: 'coji@example.com',
        name: 'Coji',
        image: null,
        initial: 'C',
      },
      renderType: 'html',
      onCopyMarkdown: () => {},
      onDownloadHtml: () => {},
      onDownloadMarkdown: () => {},
      onDownloadPdf: () => {},
    })

    expect(html).toContain('Export')
    expect(html).toContain('Copy Markdown')
    expect(html).toContain('Download HTML')
    expect(html).toContain('Download Markdown')
    expect(html).toContain('Download PDF')
  })

  test('interactive visibility chip names its current value and change action', () => {
    const html = renderChrome({
      artifact,
      user: {
        id: 'u1',
        email: 'coji@example.com',
        name: 'Coji',
        image: null,
        initial: 'C',
      },
      renderType: 'html',
    })

    expect(html).toContain('aria-label="Specific · Change visibility"')
  })

  test('chrome toggle does not link to home', () => {
    const html = renderChrome({
      artifact,
      user: null,
      renderType: 'html',
      collapsed: true,
    })

    const toggleOpenTag = html.match(
      /<button[^>]*aria-controls="viewer-topbar"[^>]*>/,
    )?.[0]
    expect(toggleOpenTag).toBeDefined()
    expect(toggleOpenTag).not.toContain('href')
    expect(html.match(/href="[^"]*"/g)).toEqual(['href="/"', 'href="/about"'])
  })
})

const artifact = {
  id: 's1',
  storageKey: 's1/index.html',
  name: 'demo.html',
  derivedTitle: 'Demo',
  titleOverride: null,
  ownerId: 'u1',
  ownerName: 'Coji',
  ownerEmail: 'coji@example.com',
  ownerImage: null,
  ownerInitial: 'C',
  modifiedTime: new Date().toISOString(),
  canReplaceFile: true,
  canViewHistory: true,
  canChangeVisibility: true,
  visibility: 'private' as const,
  workspaceHd: null,
  availableVisibilities: ['private'] as const,
  grants: [],
  viewCount: 7,
}
