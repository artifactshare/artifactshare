// @vitest-environment happy-dom
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router'
import { expect, test, vi } from 'vitest'
import { bindI18n } from '~/lib/i18n'
import SettingsLayout from './_layout'

vi.mock('./+lib/settings-request.server', () => ({
  loadSettingsShell: () => ({}),
}))
vi.mock('~/middleware/context', () => ({
  requireUser: () => ({ id: 'owner', email: 'owner@example.test' }),
}))
vi.mock('~/hooks/use-t', () => ({ useT: () => bindI18n('en') }))

test.each(['checkout-success', 'forbidden', 'ok', 'unknown'])(
  '%s notice is in the settings content column after navigation',
  (status) => {
    const html = renderToStaticMarkup(
      <MemoryRouter
        initialEntries={[
          `/settings/${status === 'forbidden' ? 'integrations' : 'billing'}?status=${status}`,
        ]}
      >
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
          }}
        />
      </MemoryRouter>,
    )
    const document = new DOMParser().parseFromString(html, 'text/html')
    const notice = document.querySelector(
      status === 'checkout-success' ? '[role="status"]' : '[role="alert"]',
    )
    const navigation = document.querySelector(
      `nav[aria-label="${bindI18n('en').t('team.nav.label')}"]`,
    )
    if (status === 'ok' || status === 'unknown') {
      expect(document.querySelector('[data-settings-status]')).toBeNull()
      return
    }
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
