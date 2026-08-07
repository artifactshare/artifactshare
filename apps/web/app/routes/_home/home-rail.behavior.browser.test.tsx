import '~/app.css'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { createMemoryRouter, RouterProvider, useLocation } from 'react-router'
import { userEvent } from 'vitest/browser'
import { HomeRail } from './+components/home-rail'
import type { FileRowData } from './+components/file-data'

vi.mock('~/hooks/use-t', () => ({
  useT: () => ({
    locale: 'en',
    t: (key: string) =>
      ({
        'home.myFiles': 'My files',
        'home.projects': 'Projects',
        'home.seeAll': 'See all',
        'home.noRecent': 'No recent files',
      })[key] ?? key,
    tPlural: (key: string, count: number) => `${key}:${count}`,
  }),
}))

vi.mock('~/hooks/use-viewer-calendar', () => ({
  useViewerCalendar: () => ({ hydrated: true, timeZone: 'UTC' }),
}))

vi.mock('~/components/app/file-type-icon', () => ({
  FileTypeIcon: () => <span aria-hidden="true">icon</span>,
}))

vi.mock('~/components/app/author-avatar', () => ({
  AuthorAvatar: () => <span aria-hidden="true">avatar</span>,
}))

function LocationProbe() {
  return <output data-route>{useLocation().pathname}</output>
}

const file = (id: string, title: string): FileRowData =>
  ({
    id,
    fileName: `${id}.md`,
    derivedTitle: title,
    titleOverride: null,
    renderType: 'md',
    visibility: 'workspace',
    ownerId: 'owner',
    ownerImage: null,
    ownerInitial: 'O',
    ownerIsExternal: false,
    ownerEmail: 'owner@example.com',
    ownerName: 'Owner',
    registeredByMe: true,
    viewCount: 1,
    commentCount: 0,
    projectName: null,
    createdTime: '2026-07-31T00:00:00.000Z',
    modifiedTime: '2026-07-31T00:00:00.000Z',
  }) as FileRowData

let root: Root | undefined

afterEach(() => {
  root?.unmount()
  root = undefined
  document.body.replaceChildren()
  vi.unstubAllGlobals()
})

async function mount() {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const router = createMemoryRouter(
    [
      {
        path: '*',
        element: (
          <>
            <HomeRail
              files={[
                file('upper', 'Upper title'),
                file('lower', 'Lower title'),
              ]}
              projects={[]}
              errors={{ files: false, projects: false, recent: false }}
              variant="without-recent"
            />
            <LocationProbe />
          </>
        ),
      },
    ],
    { initialEntries: ['/'] },
  )
  root = createRoot(host)
  root.render(<RouterProvider router={router} />)
  await vi.waitFor(() =>
    expect(host.querySelector('a[href="/a/upper"]')).not.toBeNull(),
  )
  return host
}

describe('HomeRail files behavior', () => {
  test('keeps multiple file titles free of peek on pointer and focus', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({}),
    })
    vi.stubGlobal('fetch', fetchMock)
    const host = await mount()
    const upper = host.querySelector<HTMLAnchorElement>('a[href="/a/upper"]')!
    const lower = host.querySelector<HTMLAnchorElement>('a[href="/a/lower"]')!

    upper.dispatchEvent(
      new PointerEvent('pointerover', { bubbles: true, pointerType: 'mouse' }),
    )
    lower.dispatchEvent(
      new PointerEvent('pointerover', { bubbles: true, pointerType: 'mouse' }),
    )
    upper.focus()
    await userEvent.tab()
    lower.focus()
    expect(document.querySelector('[data-peek-section="shareable"]')).toBeNull()
    expect(
      fetchMock.mock.calls.filter(([url]) =>
        String(url).includes('/api/peek/shareable/'),
      ),
    ).toHaveLength(0)
  })

  test('focuses a title with tab and enters its memory-router link', async () => {
    const host = await mount()
    const target = host.querySelector<HTMLAnchorElement>('a[href="/a/lower"]')!
    for (let i = 0; i < 10 && document.activeElement !== target; i++) {
      await userEvent.tab()
    }
    expect(document.activeElement).toBe(target)
    await userEvent.keyboard('{Enter}')
    await vi.waitFor(() =>
      expect(host.querySelector('[data-route]')?.textContent).toBe('/a/lower'),
    )
  })
})
