// @vitest-environment happy-dom
import { renderToStaticMarkup } from 'react-dom/server'
import {
  act,
  type AnchorHTMLAttributes,
  type ComponentProps,
  type ReactNode,
} from 'react'
import { createRoot } from 'react-dom/client'
import { copyShareUrl } from '~/lib/clipboard'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import en from '~/i18n/en.json'
import ja from '~/i18n/ja.json'
import { shortVisibilityLabelKey } from '~/lib/visibility-labels'
import { TooltipProvider } from '~/components/ui/tooltip'
import {
  anonymousViewerSignInUrl,
  historicalViewerShareUrl,
  ViewerChrome,
} from './viewer-chrome'

vi.mock('~/lib/clipboard', () => ({ copyShareUrl: vi.fn() }))

vi.mock('~/hooks/use-hydrated', () => ({
  useHydrated: () => true,
}))

let mockDictionary: typeof en | null = null

vi.mock('~/hooks/use-t', () => ({
  useT: () => ({
    locale: mockDictionary === ja ? 'ja' : 'en',
    t: (key: string, vars?: Record<string, string | number>) =>
      mockDictionary?.[key as keyof typeof en] ??
      {
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
        'vw.bridgeAttributionOpen': `Show share details for ${vars?.requester ?? ''}`,
        'vw.bridgeAttributionDetails': 'Share details',
        'vw.bridgeRequestedBy': 'Requested by',
        'vw.bridgePublishedVia': 'Published via',
        'author.external': 'External',
        'vw.titleEditPlaceholder':
          'Save empty to restore the auto-extracted title',
        'menu.remove': 'Remove',
        'vw.viewerListMenuItem': 'Who viewed',
        'vw.viewerListEntryLabel': `${vars?.label ?? ''}, show who viewed`,
        'analyticsConsent.change': 'Change analytics consent',
        'home.inboxLabel': 'Home',
      }[key] ??
      key,
    tPlural: (key: string, n: number) =>
      key === 'card.viewCount'
        ? `${n} views`
        : key === 'vw.viewerListCount'
          ? n === 1
            ? `${n} person`
            : `${n} people`
          : `${n}`,
  }),
}))

let mockLocationState: unknown = null
let mockLocationSearch = ''
const mockNavigate = vi.fn()

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
  useLocation: () => ({
    pathname: '/a/artifact',
    search: mockLocationSearch,
    state: mockLocationState,
  }),
  useNavigate: () => mockNavigate,
  useRevalidator: () => ({ revalidate: vi.fn() }),
}))

vi.mock('~/components/app/avatar-menu', () => ({
  AvatarMenu: ({
    onAccessRequestDismiss,
  }: {
    onAccessRequestDismiss?: () => void
  }) => (
    <button type="button" onClick={onAccessRequestDismiss}>
      Account
    </button>
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
    <div className="dropdown-menu-content">{children}</div>
  ),
  DropdownMenuItem: ({
    children,
    onSelect,
    className,
    ...props
  }: {
    children: ReactNode
    onSelect?: (event: Event) => void
    className?: string
  } & Record<string, unknown>) => (
    <button
      type="button"
      className={className}
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

vi.mock('./visibility-dialog', () => ({
  VisibilityDialog: () => null,
}))

vi.mock('./move-shareable-dialog', () => ({
  MoveShareableDialog: () => null,
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

  test('builds link-domain sign-in URLs on the app origin', () => {
    expect(
      anonymousViewerSignInUrl('https://artifactshare.com', 'abc123def4'),
    ).toBe('https://artifactshare.com/sign-in?next=%2Fa%2Fabc123def4')
    expect(anonymousViewerSignInUrl(undefined, 'abc123def4')).toBe(
      '/sign-in?next=%2Fa%2Fabc123def4',
    )
  })

  test('keeps a historical version in copied URLs and removes access-request', () => {
    expect(
      historicalViewerShareUrl(
        'https://abc123def4.artifactshare.link/?version=v1&access-request=req-1&panel=comments#note',
      ),
    ).toBe(
      'https://abc123def4.artifactshare.link/?version=v1&panel=comments#note',
    )
    expect(
      historicalViewerShareUrl('https://abc123def4.artifactshare.link/'),
    ).toBeNull()
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

  test('anonymous link viewer can change analytics consent', () => {
    const html = renderChrome({
      artifact,
      user: null,
      appOrigin: 'https://artifactshare.com',
      renderType: 'html',
    })

    expect(html).toContain('aria-label="Change analytics consent"')
  })

  test('anonymous link viewer uses a link for cross-domain sign-in', () => {
    const html = renderChrome({
      artifact,
      user: null,
      appOrigin: 'https://artifactshare.com',
      analyticsMode: 'enabled',
      renderType: 'html',
    })

    expect(html).toMatch(
      /<a(?=[^>]*href="https:\/\/artifactshare\.com\/sign-in\?next=%2Fa%2Fs1")[^>]*>signin\.cta<\/a>/,
    )
    expect(html).not.toMatch(/<button[^>]*>signin\.cta<\/button>/)
  })

  test('anonymous link viewer omits the sign-in href without analytics consent', () => {
    const html = renderChrome({
      artifact,
      user: null,
      appOrigin: 'https://artifactshare.com',
      analyticsMode: 'disabled',
      renderType: 'html',
    })

    expect(html).toMatch(/<button[^>]*>signin\.cta<\/button>/)
    expect(html).not.toContain(
      'href="https://artifactshare.com/sign-in?next=%2Fa%2Fs1"',
    )
  })

  test('keeps the copy-link focus ring without the resting shadow', () => {
    const html = renderChrome({
      artifact,
      user: null,
      renderType: 'html',
    })
    const copyButton = html.match(
      /<button[^>]*aria-label="Copy URL"[^>]*>/,
    )?.[0]

    expect(copyButton).toBeDefined()
    expect(copyButton).not.toContain('shadow-[var(--shadow-sm)]')
    expect(copyButton).toContain('focus-visible:ring-3')
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

  test('attributes a bridge-published artifact to the requester via the bot', () => {
    const html = renderChrome({
      artifact: {
        ...artifact,
        ownerName: 'Publishing bot',
        ownerEmail: 'publishing-bot@example.com',
        ownerKind: 'bot',
        bridgeRequesterLabel: 'Aki Tanaka',
        ownerIsExternal: true,
      },
      user: null,
      renderType: 'html',
    })

    expect(html).toContain('data-bridge-attribution-trigger="true"')
    expect(html).toContain('title="Aki Tanaka"')
    expect(html).toContain('aria-label="Show share details for Aki Tanaka"')
    expect(html).not.toContain('(via Publishing bot)')
    expect(html).not.toContain('External')
    expect(html).not.toContain('data-testid="bot-badge"')
    expect(html).not.toContain('aki@example.com')
    expect(html).toMatch(
      /<span[^>]*data-viewer-owner-segment[^>]*class="[^"]*max-viewer:hidden[^"]*"/,
    )
    expect(html).toContain('max-viewer:inline-flex max-phone:hidden')
  })

  test('falls back to the verified requester email for bridge attribution', () => {
    const html = renderChrome({
      artifact: {
        ...artifact,
        ownerName: 'Publishing bot',
        ownerKind: 'bot',
        bridgeRequesterLabel: 'aki@example.com',
      },
      user: null,
      renderType: 'html',
    })

    expect(html).toContain('title="aki@example.com"')
    expect(html).toContain(
      'aria-label="Show share details for aki@example.com"',
    )
  })

  test('keeps the publishing bot readable on anonymous phones without a requester label', () => {
    const html = renderChrome({
      artifact: {
        ...artifact,
        ownerName: 'Publishing bot',
        ownerKind: 'bot',
        bridgeRequesterLabel: null,
      },
      user: null,
      renderType: 'html',
    })

    expect(html).toContain('max-phone:col-span-3')
    expect(html).toContain('Publishing bot')
    expect(html).toContain('data-testid="bot-badge"')
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

  test('collapsed chrome toggle keeps only the brand mark and expand icon', () => {
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
    const toggle = html.match(
      /<button[^>]*aria-label="Show Artifact Share"[^>]*>[\s\S]*?<\/button>/,
    )?.[0]
    expect(toggle).toBeDefined()
    expect(toggle).toContain('bg-[url(/favicon.svg)]')
    expect(toggle).not.toContain('>Artifact Share<')
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

  test('desktop and mobile visibility chips use the same glossary label', () => {
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

    expect(
      html.match(/aria-label="Specific · Change visibility"/g),
    ).toHaveLength(2)
    expect(
      html.match(/data-regression-responsive="desktop-only"/g),
    ).toHaveLength(1)
    expect(
      html.match(/data-regression-responsive="mobile-only"/g),
    ).toHaveLength(1)
  })

  test('hides the owner metadata segment at phone width', () => {
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

    expect(html).toMatch(
      /<span[^>]*data-viewer-owner-segment[^>]*class="[^"]*max-phone:hidden[^"]*"/,
    )

    const anonymousHtml = renderChrome({
      artifact,
      user: null,
      renderType: 'html',
    })
    expect(anonymousHtml).not.toMatch(
      /<span[^>]*data-viewer-owner-segment[^>]*class="[^"]*max-phone:hidden[^"]*"/,
    )
    expect(anonymousHtml).toMatch(
      /data-viewer-owner-segment[^>]*><span class="max-phone:hidden"[^>]*>·<\/span>/,
    )
    expect(anonymousHtml).toMatch(
      /<span class="max-phone:inline hidden"[^>]*>·<\/span><\/span>/,
    )
  })

  test('names Home when the file has no project', () => {
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

    expect(html).toContain('Home')
    expect(html).toMatch(
      /class="[^"]*max-phone:shrink-0[^"]*max-phone:order-first[^"]*" title="Home"/,
    )
    expect(html).toMatch(/class="[^"]*max-phone:order-2[^"]*"/)
  })

  test('uses the current location as the move entry when moving is available', () => {
    const html = renderChrome({
      artifact: {
        ...artifact,
        canMove: true,
        projectId: 'project-1',
        projectName: 'Launch planning',
      },
      user: {
        id: 'u1',
        email: 'coji@example.com',
        name: 'Coji',
        image: null,
        initial: 'C',
      },
      renderType: 'html',
    })

    const entry = html.match(/<button[^>]*data-viewer-move-entry[^>]*>/)?.[0]
    expect(entry).toBeDefined()
    expect(entry).toContain('aria-haspopup="dialog"')
    expect(entry).toContain('aria-expanded="false"')
    expect(entry).toContain('data-slot="button"')
    expect(entry).toContain('data-size="xs"')
    expect(entry?.match(/class="([^"]*)"/)?.[1].split(/\s+/)).toContain(
      'shrink',
    )
    expect(entry).toContain('max-phone:shrink-0')
    expect(entry).toContain(
      'aria-label="Launch planning · Move to another place"',
    )
    expect(entry).toContain('title="Launch planning · Move to another place"')
    expect(html).toContain('>Launch planning</span>')
    expect(html).not.toContain('href="/projects/project-1"')
  })

  test('keeps project navigation when moving is unavailable', () => {
    const html = renderChrome({
      artifact: {
        ...artifact,
        projectId: 'project-1',
        projectName: 'Launch planning',
      },
      user: {
        id: 'u2',
        email: 'viewer@example.com',
        name: 'Viewer',
        image: null,
        initial: 'V',
      },
      renderType: 'html',
    })

    expect(html).not.toContain('data-viewer-move-entry')
    expect(html).not.toContain(
      'aria-label="Launch planning · Move to another place"',
    )
    expect(html).toContain('href="/projects/project-1"')
    expect(html).toContain('title="Launch planning"')
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
  })
})

describe('viewer list entry', () => {
  const signedInUser = {
    id: 'u1',
    email: 'coji@example.com',
    name: 'Coji',
    image: null,
    initial: 'C',
  }

  test('renders the meta-row entry button with a single combined text node', () => {
    const html = renderChrome({
      artifact: {
        ...artifact,
        showViewerListMetaEntry: true,
        viewerListCount: 3,
      },
      user: signedInUser,
      renderType: 'html',
      onViewerListEntrySelect: () => {},
    })

    const entryTag = html.match(/<button[^>]*data-viewer-list-entry[^>]*>/)?.[0]
    expect(entryTag).toBeDefined()
    expect(entryTag).toContain('aria-haspopup="dialog"')
    expect(entryTag).toContain('aria-expanded="false"')
    expect(entryTag).toContain(
      'aria-label="7 views · 3 people, show who viewed"',
    )
    // Single text node: visible string appears whole, without separator spans.
    expect(html).toContain('>7 views · 3 people</button>')
    expect(html).not.toContain('<span aria-hidden="true">·</span></button>')
  })

  test('aria-expanded reflects the panel open state regardless of origin', () => {
    const html = renderChrome({
      artifact: {
        ...artifact,
        showViewerListMetaEntry: true,
        viewerListCount: 3,
      },
      user: signedInUser,
      renderType: 'html',
      viewerListOpen: true,
      onViewerListEntrySelect: () => {},
    })

    const entryTag = html.match(/<button[^>]*data-viewer-list-entry[^>]*>/)?.[0]
    expect(entryTag).toContain('aria-expanded="true"')
  })

  test('team workspace with zero viewers still renders the entry button', () => {
    const html = renderChrome({
      artifact: {
        ...artifact,
        showViewerListMetaEntry: true,
        viewerListCount: 0,
      },
      user: signedInUser,
      renderType: 'html',
      onViewerListEntrySelect: () => {},
    })

    expect(html).toContain('>7 views · 0 people</button>')
  })

  test('renders the menu item under the same gate', () => {
    const html = renderChrome({
      artifact: {
        ...artifact,
        showViewerListMetaEntry: true,
        viewerListCount: 3,
      },
      user: signedInUser,
      renderType: 'html',
      onViewerListEntrySelect: () => {},
    })

    expect(html).toContain('data-viewer-list-menu-item')
    expect(html).toContain('Who viewed')
  })

  test('without the gate the plain view count text stays unchanged', () => {
    const html = renderChrome({
      artifact,
      user: signedInUser,
      renderType: 'html',
      onViewerListEntrySelect: () => {},
    })

    expect(html).not.toContain('data-viewer-list-entry')
    expect(html).not.toContain('data-viewer-list-menu-item')
    expect(html).toContain('>7 views</span>')
  })

  test('anonymous viewers never see the entry even when the flag is set', () => {
    const html = renderChrome({
      artifact: {
        ...artifact,
        showViewerListMetaEntry: true,
        viewerListCount: 3,
      },
      user: null,
      renderType: 'html',
      onViewerListEntrySelect: () => {},
    })

    expect(html).not.toContain('data-viewer-list-entry')
    expect(html).toContain('>7 views</span>')
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

describe.each([
  ['en', en],
  ['ja', ja],
] as const)('viewer sharing chips (%s)', (_locale, dictionary) => {
  const user = {
    id: 'u1',
    email: 'owner@example.com',
    name: 'Owner',
    image: null,
    initial: 'O',
  }

  beforeEach(() => {
    mockDictionary = dictionary
    return () => {
      mockDictionary = null
    }
  })

  function chips(html: string) {
    return [
      ...html.matchAll(
        /<(button|span)\b[^>]*data-slot="badge"[^>]*>[\s\S]*?<span>[^<]*<\/span><\/\1>/g,
      ),
    ].map(([chip]) => chip)
  }

  test.each([true, false])(
    'paused chips preserve edit permission: %s',
    (editable) => {
      const html = renderChrome({
        artifact: {
          ...artifact,
          visibility: 'link',
          linkSuspended: true,
          canChangeVisibility: editable,
        },
        user: editable ? user : { ...user, id: 'u2' },
        renderType: 'html',
      })
      const label = dictionary['vw.linkSharingPaused']
      const name = editable
        ? `${label} · ${dictionary['vw.changeVisibility']}`
        : label
      const rendered = chips(html)
      expect(rendered).toHaveLength(2)
      expect(rendered.join('')).toContain(
        'data-regression-responsive="desktop-only"',
      )
      expect(rendered.join('')).toContain(
        'data-regression-responsive="mobile-only"',
      )
      for (const chip of rendered) {
        const tag = chip.slice(0, chip.indexOf('>') + 1)
        expect(chip).toContain(`<span>${label}</span>`)
        expect(tag).toContain(`aria-label="${name}"`)
        expect(tag).toContain(`title="${label}"`)
        expect(tag).toContain('data-variant="warning"')
        expect(chip).toContain('tabler-icon-link')
        if (tag.includes('data-regression-responsive="desktop-only"')) {
          expect(tag).toContain('max-phone:hidden')
        } else {
          expect(tag).toContain('max-w-full')
        }
        if (editable) {
          expect(tag).toMatch(/^<button\b/)
          expect(tag).not.toContain('role=')
        } else {
          expect(tag).toMatch(/^<span\b/)
          expect(tag).toContain('role="group"')
          expect(tag).not.toContain('tabindex=')
          expect(chip).not.toContain(dictionary['vw.changeVisibility'])
          expect(chip).not.toContain('<button')
        }
      }
      expect(html).toContain(`aria-label="${dictionary['vw.copyUrl']}"`)
    },
  )

  test.each([
    ['link', false, 'warning'],
    ['link', undefined, 'warning'],
    ['private', true, 'muted'],
    ['project', true, 'success'],
    ['workspace', true, 'info'],
  ] as const)(
    'preserves ordinary %s chips with suspension %s',
    (visibility, linkSuspended, variant) => {
      for (const editable of [true, false]) {
        const rendered = chips(
          renderChrome({
            artifact: {
              ...artifact,
              visibility,
              linkSuspended,
              canChangeVisibility: editable,
            },
            user,
            renderType: 'html',
          }),
        )
        expect(rendered).toHaveLength(2)
        const label = dictionary[shortVisibilityLabelKey(visibility)]
        for (const chip of rendered) {
          expect(chip).toContain(`<span>${label}</span>`)
          expect(chip).toContain(`data-variant="${variant}"`)
          expect(chip).not.toContain(dictionary['vw.linkSharingPaused'])
          if (editable) {
            expect(chip).toContain(
              `aria-label="${label} · ${dictionary['vw.changeVisibility']}"`,
            )
          } else {
            expect(chip).not.toContain('aria-label=')
            expect(chip).not.toContain('role=')
          }
        }
      }
    },
  )

  test('omits anonymous and invalid-visibility chips even when suspended', () => {
    for (const props of [
      { user: null, visibility: 'link' },
      { user, visibility: 'invalid' },
    ]) {
      expect(
        chips(
          renderChrome({
            artifact: {
              ...artifact,
              visibility: props.visibility as ComponentProps<
                typeof ViewerChrome
              >['artifact']['visibility'],
              linkSuspended: true,
            },
            user: props.user,
            renderType: 'html',
          }),
        ),
      ).toHaveLength(0)
    }
  })
})

test.each(['private', 'link'] as const)(
  'latest-version Copy link reads the live hash for %s sharing',
  async (visibility) => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    const previousUrl = window.location.href
    const previousState = window.history.state
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
    try {
      window.history.replaceState(null, '', '/a/abc123def4#initial')
      await act(async () =>
        root.render(
          <TooltipProvider>
            <ViewerChrome
              artifact={{ ...artifact, id: 'abc123def4', visibility }}
              user={null}
              renderType="html"
              appOrigin="https://artifactshare.com"
            />
          </TooltipProvider>,
        ),
      )
      window.history.replaceState(null, '', '#current')
      const button = host.querySelector<HTMLButtonElement>(
        '[aria-label="Copy URL"]',
      )!
      expect(button).not.toBeNull()
      await act(async () => button.click())
      expect(vi.mocked(copyShareUrl).mock.calls.at(-1)?.[0]).toBe(
        visibility === 'link'
          ? 'https://abc123def4.artifactshare.link/#current'
          : 'https://artifactshare.com/a/abc123def4#current',
      )
    } finally {
      await act(async () => root.unmount())
      host.remove()
      window.history.replaceState(previousState, '', previousUrl)
    }
  },
)

test('access-request dismissal through ViewerChrome preserves the live fragment', async () => {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  const previousUrl = window.location.href
  mockLocationSearch = '?access-request=s1&panel=comments'
  try {
    await act(async () =>
      root.render(
        <TooltipProvider>
          <ViewerChrome
            artifact={artifact}
            user={{
              id: 'u1',
              email: 'owner@example.com',
              name: 'Owner',
              image: null,
              initial: 'O',
            }}
            renderType="html"
          />
        </TooltipProvider>,
      ),
    )
    window.history.replaceState(null, '', '#live')
    const account = Array.from(host.querySelectorAll('button')).find(
      (button) => button.textContent === 'Account',
    )!
    await act(async () => account.click())
    expect(mockNavigate).toHaveBeenLastCalledWith(
      { pathname: '/a/artifact', search: '?panel=comments', hash: '#live' },
      { replace: true },
    )
  } finally {
    mockLocationSearch = ''
    await act(async () => root.unmount())
    host.remove()
    window.history.replaceState(null, '', previousUrl)
  }
})
