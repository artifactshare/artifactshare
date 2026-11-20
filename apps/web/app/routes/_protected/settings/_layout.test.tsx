// @vitest-environment happy-dom
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router'
import { expect, test, vi } from 'vitest'
import { bindI18n } from '~/lib/i18n'
import SettingsLayout from './_layout'

vi.mock('~/services/db.server', () => ({}))
vi.mock('~/services/team-management.server', () => ({}))
vi.mock('~/services/project-membership.server', () => ({}))
vi.mock('~/middleware/context', () => ({}))
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
