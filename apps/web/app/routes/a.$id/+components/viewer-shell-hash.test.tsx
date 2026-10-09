// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, test, vi } from 'vitest'
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
  useNavigate: () => navigation.navigate,
  useRevalidator: () => ({ revalidate: vi.fn() }),
}))
vi.mock('~/hooks/use-t', async () => {
  const { bindI18n } = await import('~/lib/i18n')
  return { useT: () => bindI18n('en') }
})
vi.mock('./viewer-chrome', () => ({
  ViewerChrome: ({
    onAccessRequestsOpenChange,
  }: {
    onAccessRequestsOpenChange: (open: boolean) => void
  }) => (
    <button onClick={() => onAccessRequestsOpenChange(false)}>
      Close access requests
    </button>
  ),
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
  navigation.navigate.mockClear()
  window.history.replaceState(null, '', previousUrl)
})

test.each(['comment', 'access-request'])(
  '%s query cleanup reads the live hash and preserves other parameters',
  async (parameter) => {
    navigation.location.search = `?${parameter}=s1&version=v1`
    window.history.replaceState(null, '', '/#live')
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
        await act(async () => host.querySelector('button')!.click())
      }
      expect(navigation.navigate).toHaveBeenCalledWith(
        {
          pathname: '/a/abc123def4',
          search: '?version=v1',
          hash: parameter === 'comment' ? '#live' : '#at-close',
        },
        { replace: true, preventScrollReset: true },
      )
    } finally {
      await act(async () => root.unmount())
      host.remove()
    }
  },
)
