// @vitest-environment happy-dom
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter, RouterContextProvider } from 'react-router'
import { expect, test, vi } from 'vitest'
import { bindI18n } from '~/lib/i18n'
import SettingsLayout, { loader } from './_layout'

vi.mock('~/services/db.server', () => ({ createDb: () => ({}) }))
vi.mock('~/services/team-management.server', () => ({
  loadSettingsShell: () => ({}),
}))
const projects = vi.hoisted(() => vi.fn())
vi.mock('~/services/project-membership.server', () => ({
  listJoinedProjectsForDropdown: projects,
}))
vi.mock('~/middleware/context', () => ({
  requireUser: () => ({ id: 'owner', email: 'owner@example.test' }),
}))
vi.mock('~/hooks/use-t', () => ({ useT: () => bindI18n('en') }))
vi.mock('../../_home/+components/topbar', () => ({ Topbar: () => null }))
vi.mock('../../_home/+components/bottom-tab-bar', () => ({
  BottomTabBar: () => null,
}))

test.each(['ok', 'forbidden'])(
  '%s notice is in the settings content column after navigation',
  (status) => {
    const html = renderToStaticMarkup(
      <MemoryRouter initialEntries={[`/settings?status=${status}`]}>
        <SettingsLayout
          loaderData={{
            kind: 'team',
            workspace: {
              id: 'workspace',
              name: 'Example workspace',
              hd: null,
              plan: 'team',
              storageUsedBytes: 0,
              storageQuotaBytes: 100,
            },
            currentUserIsAdmin: true,
            currentUserRole: 'owner',
            user: {
              id: 'owner',
              name: 'Owner',
              email: 'owner@example.com',
              image: null,
              initial: 'O',
            },
            joinedProjects: [],
          }}
        />
      </MemoryRouter>,
    )
    const document = new DOMParser().parseFromString(html, 'text/html')
    const notice = document.querySelector(
      status === 'ok' ? '[role="status"]' : '[role="alert"]',
    )
    const navigation = document.querySelector(
      `nav[aria-label="${bindI18n('en').t('team.nav.label')}"]`,
    )
    expect(notice).not.toBeNull()
    expect(navigation).not.toBeNull()
    if (!notice || !navigation) throw new Error('Missing settings content')
    expect(
      navigation.compareDocumentPosition(notice) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()
    expect(notice.parentElement?.querySelector('nav')).toBeNull()
    expect(notice.parentElement?.closest('main')).not.toBeNull()
  },
)

test('a failed projects query leaves the settings shell available with an empty list', async () => {
  projects.mockRejectedValueOnce(new TypeError('query failed'))
  const log = vi.spyOn(console, 'error').mockImplementation(() => {})
  const url = new URL('https://app.example/settings')
  const data = await loader({
    context: new RouterContextProvider(),
    params: {},
    request: new Request(url),
    url,
    pattern: '/settings',
  })
  expect(data.joinedProjects).toEqual([])
  expect(log.mock.calls).toEqual([
    [
      {
        operation: 'settings.projects',
        cause: 'TypeError',
        frames: expect.any(Array),
      },
    ],
  ])
  log.mockRestore()
})
