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
import MembersPage from './index'
import type {
  MembersPageFilters,
  RemovedTeamMember,
  WorkspaceMemberRole,
} from '~/lib/team-management'

function renderMembers(
  role: WorkspaceMemberRole,
  removedMembers: RemovedTeamMember[] = [],
  filters: MembersPageFilters = {
    query: '',
    page: 1,
    role: 'all',
    activity: 'all',
  },
) {
  const router = createMemoryRouter([
    {
      element: <Outlet context={{ kind: 'team', user: { id: 'current' } }} />,
      children: [
        {
          path: '/',
          element: (
            <MembersPage
              loaderData={{
                currentUserRole: role,
                currentUserIsAdmin: role !== 'member',
                removedMembers,
                filters,
                membersPage: { members: [], total: 0, page: 1 },
              }}
            />
          ),
        },
      ],
    },
  ])
  const doc = new Window().document
  doc.body.innerHTML = renderToStaticMarkup(<RouterProvider router={router} />)
  router.dispose()
  return doc
}

test.each(['en', 'ja'] as const)(
  'member management explains the restricted actions in %s',
  (locale) => {
    language.locale = locale
    const { t } = bindI18n(locale)
    for (const role of ['member', 'admin', 'owner'] as const) {
      const doc = renderMembers(role)
      const section = doc.querySelector('form')!.closest('section')!
      expect(
        section.textContent.includes(t('team.members.managerActions')),
      ).toBe(role === 'member')
      expect(section.textContent.includes(t('team.members.ownerActions'))).toBe(
        role !== 'owner',
      )
      expect(
        [...doc.querySelectorAll('button')].some(
          (button) => button.textContent === t('team.removedMembers.transfer'),
        ),
      ).toBe(false)
    }
  },
)

test('only managers can transfer artifacts from a removed member', () => {
  language.locale = 'en'
  for (const role of ['admin', 'member'] as const) {
    const doc = renderMembers(role, [
      {
        id: 'removed',
        name: 'Removed',
        image: null,
        email: 'removed@example.test',
        ownedArtifactCount: 1,
      },
    ])
    const buttons = [...doc.querySelectorAll('button')].filter(
      (button) => button.textContent === 'Transfer files',
    )
    expect(buttons).toHaveLength(role === 'admin' ? 1 : 0)
    if (role === 'admin') expect(buttons[0].disabled).toBe(false)
  }
})

test.each(['en', 'ja'] as const)(
  'server-rendered member filters show field labels and selections in %s',
  (locale) => {
    language.locale = locale
    const { t } = bindI18n(locale)
    for (const filtered of [false, true]) {
      const doc = renderMembers('member', [], {
        query: '',
        page: 1,
        role: filtered ? 'admin' : 'all',
        activity: filtered ? 'active' : 'all',
      })
      const pairs = [
        [
          'member-role-filter',
          t('team.members.filter.role'),
          t(
            filtered
              ? 'team.members.role.admin'
              : 'team.members.filter.role.all',
          ),
        ],
        [
          'member-activity-filter',
          t('team.members.filter.activity'),
          t(
            filtered
              ? 'team.members.filter.activity.active'
              : 'team.members.filter.activity.all',
          ),
        ],
      ]

      for (const [id, label, value] of pairs) {
        const field = doc.querySelector(`label[for="${id}"]`)!
        expect(field.textContent).toBe(label)
        expect(
          field.closest('.sr-only, .hidden, [hidden], [aria-hidden="true"]'),
        ).toBeNull()
        expect(
          doc.querySelector(`button[role="combobox"]#${id}`)?.textContent,
        ).toBe(value)
      }
    }
  },
)
