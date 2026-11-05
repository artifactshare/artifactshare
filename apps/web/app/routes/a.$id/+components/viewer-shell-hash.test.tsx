// @vitest-environment happy-dom
import { act, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, test, vi } from 'vitest'
import { createViewerHashSync } from '~/lib/viewer-hash'
import { ViewerShell, type ViewerShellArtifact } from './viewer-shell'

const navigation = vi.hoisted(() => ({
  navigate: vi.fn(),
  location: {
    pathname: '/a/abc123def4',
    search: '',
    hash: '#stale',
    state: null,
  },
}))
vi.mock('react-router', async (original) => ({
  ...(await original<typeof import('react-router')>()),
  useLocation: () => navigation.location,
  useViewTransitionState: () => false,
  useNavigate: () => navigation.navigate,
  useRevalidator: () => ({ revalidate: vi.fn() }),
}))
vi.mock('~/hooks/use-t', async () => {
  const { bindI18n } = await import('~/lib/i18n')
  return { useT: () => bindI18n('en') }
})
vi.mock('./sandbox-frame', () => ({
  SandboxFrame: ({ url }: { url: string }) => <div data-frame-url={url} />,
}))
vi.mock('./viewer-chrome', () => ({
  ViewerChrome: ({
    onAccessRequestsOpenChange,
    bodyHref,
  }: {
    bodyHref?: string
    onAccessRequestsOpenChange: (open: boolean) => void
  }) => {
    const [open, setOpen] = useState(false)
    return (
      <>
        <button onClick={() => onAccessRequestsOpenChange(false)}>
          Close access requests
        </button>
        {bodyHref ? (
          <>
            <button data-more onClick={() => setOpen(!open)}>
              More
            </button>
            {open ? <a href={bodyHref}>Open body</a> : null}
          </>
        ) : null}
      </>
    )
  },
}))
const artifact: ViewerShellArtifact = {
  id: 'abc123def4',
  storageKey: 'abc123def4/index.html',
  name: 'Example',
  derivedTitle: null,
  titleOverride: null,
  ownerId: 'u1',
  ownerName: 'Owner',
  ownerEmail: 'owner@example.com',
  ownerImage: null,
  ownerInitial: 'O',
  modifiedTime: '2026-01-01T00:00:00.000Z',
  viewCount: 0,
  visibility: 'private',
  workspaceHd: null,
  availableVisibilities: ['private'],
  grants: [],
}
const previousUrl = window.location.href
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
afterEach(() => {
  vi.unstubAllGlobals()
  navigation.navigate.mockReset()
  vi.useRealTimers()
  window.history.replaceState(null, '', previousUrl)
})

test.each([
  { parameter: 'comment', pending: false },
  { parameter: 'access-request', pending: false },
  { parameter: 'comment', pending: true },
  { parameter: 'access-request', pending: true },
])(
  '$parameter query cleanup preserves the latest hash and other parameters (pending: $pending)',
  async ({ parameter, pending }) => {
    vi.useFakeTimers()
    const hashSync = createViewerHashSync()
    navigation.location.search = `?${parameter}=s1&version=v1`
    window.history.replaceState(null, '', `/${navigation.location.search}#live`)
    navigation.navigate.mockImplementation(({ pathname, search, hash }) => {
      window.history.replaceState(null, '', pathname + search + hash)
    })
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise<Response>(() => {})),
    )
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    try {
      if (pending && parameter === 'comment') hashSync.accept('#accepted')
      await act(async () =>
        root.render(
          <ViewerShell
            artifact={artifact}
            user={null}
            renderType={null}
            sandboxUrl={null}
            bundlePaths={[]}
          />,
        ),
      )
      if (parameter === 'access-request') {
        window.history.replaceState(null, '', '#at-close')
        if (pending) hashSync.accept('#accepted')
        await act(async () => host.querySelector('button')!.click())
      }
      expect(navigation.navigate).toHaveBeenCalledWith(
        {
          pathname: '/a/abc123def4',
          search: '?version=v1',
          hash: pending
            ? '#accepted'
            : parameter === 'comment'
              ? '#live'
              : '#at-close',
        },
        { replace: true, preventScrollReset: true },
      )
      await act(async () => vi.advanceTimersByTime(200))
      expect(window.location.pathname).toBe('/a/abc123def4')
      expect(window.location.search).toBe('?version=v1')
      expect(window.location.hash).toBe(
        pending ? '#accepted' : parameter === 'comment' ? '#live' : '#at-close',
      )
    } finally {
      hashSync.clear()
      await act(async () => root.unmount())
      host.remove()
    }
  },
)

test.each([
  ['html', false, true, false],
  ['html', false, false, true],
  ['md', false, true, false],
  ['html', true, false, false],
  ['md', true, false, false],
  ['static_site', false, false, false],
  [null, false, false, false],
] as const)(
  'body action for %s, low trust %s follows the displayed version',
  async (renderType, lowTrust, eligible, deliveryUnavailable) => {
    navigation.location.search = ''
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise<Response>(() => {})),
    )
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    try {
      await act(async () =>
        root.render(
          <ViewerShell
            artifact={{
              ...artifact,
              currentVersionId: 'current',
              displayedVersionId: 'older',
            }}
            user={null}
            renderType={renderType}
            sandboxUrl={
              renderType
                ? deliveryUnavailable
                  ? 'https://usercontent.example/.well-known/artifactshare-delivery-unavailable'
                  : 'https://usercontent.example/?__as_token=frame-only'
                : null
            }
            linkSafety={{ lowTrust }}
            bundlePaths={[]}
          />,
        ),
      )
      expect(host.querySelector('a')).toBeNull()
      const more = host.querySelector<HTMLButtonElement>('[data-more]')
      expect(Boolean(more)).toBe(eligible)
      if (more) await act(async () => more.click())
      expect(host.querySelector('a')?.getAttribute('href')).toBe(
        eligible ? '/a/abc123def4/body?version=older' : undefined,
      )
    } finally {
      await act(async () => root.unmount())
      host.remove()
    }
  },
)
