import { Window } from 'happy-dom'
import { renderToStaticMarkup } from 'react-dom/server'
import { createMemoryRouter, Outlet, RouterProvider } from 'react-router'
import { expect, test, vi } from 'vitest'
import { bindI18n } from '~/lib/i18n'

const language = vi.hoisted(() => ({ locale: 'en' as 'en' | 'ja' }))
vi.mock('~/hooks/use-t', () => ({ useT: () => bindI18n(language.locale) }))
vi.mock('~/services/team-management.server', () => ({}))
vi.mock('~/services/db.server', () => ({}))
vi.mock('~/middleware/context', () => ({}))
import GeneralPage from './general'

test.each(['en', 'ja'] as const)(
  'workspace name explains read-only access in %s',
  (locale) => {
    language.locale = locale
    const { t } = bindI18n(locale)
    for (const role of ['member', 'admin', 'owner']) {
      const restricted = role === 'member'
      const router = createMemoryRouter([
        {
          element: (
            <Outlet
              context={{
                workspace: { name: 'Reports' },
                currentUserRole: role,
                currentUserIsAdmin: !restricted,
              }}
            />
          ),
          children: [
            {
              path: '/',
              element: <GeneralPage loaderData={{ owner: null }} />,
            },
          ],
        },
      ])
      const doc = new Window().document
      doc.body.innerHTML = renderToStaticMarkup(
        <RouterProvider router={router} />,
      )
      router.dispose()
      const field = doc.querySelector('input[name="workspaceName"]')!
      const section = field.closest('section')!
      expect(field.getAttribute('value')).toBe('Reports')
      expect(field.hasAttribute('disabled')).toBe(restricted)
      const save = section.querySelector('button')!
      expect(save.disabled).toBe(restricted)
      const guidance = section.querySelector('#name-guidance')
      for (const control of [field, save])
        expect(control.getAttribute('aria-describedby')).toBe(
          restricted ? guidance!.id : null,
        )
      expect(
        section.textContent.includes(t('team.workspace.name.readOnly')),
      ).toBe(restricted)
    }
  },
)
