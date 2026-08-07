import { renderToStaticMarkup } from 'react-dom/server'
import type { ReactNode } from 'react'
import { describe, expect, test, vi } from 'vitest'

const services = vi.hoisted(() => ({ updateWorkspaceName: vi.fn() }))
const pageState = vi.hoisted(() => ({
  context: null as unknown,
  navigation: { formData: undefined as FormData | undefined },
}))

vi.mock('~/services/db.server', () => ({ createDb: () => ({}) }))
vi.mock('~/middleware/context', () => ({
  requireUser: () => ({ id: 'user', workspaceId: 'workspace' }),
}))
vi.mock('~/services/team-management.server', () => services)
vi.mock('react-router', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-router')>()),
  Form: ({ children, ...props }: { children: ReactNode }) => (
    <form {...props}>{children}</form>
  ),
  Link: ({ children, to }: { children: ReactNode; to: string }) => (
    <a href={to}>{children}</a>
  ),
  useNavigation: () => pageState.navigation,
  useFetcher: () => ({ state: 'idle', submit: vi.fn() }),
  useRouteLoaderData: () => ({
    analyticsConsent: { shouldLoadAnalytics: false, state: 'unset' },
  }),
  useOutletContext: () => pageState.context,
}))
vi.mock('~/hooks/use-t', () => ({
  useT: () => ({
    locale: 'en',
    t: (key: string) =>
      ({
        'team.workspace.name': 'Display name',
        'team.workspace.name.body': 'Change the display name.',
        'team.workspace.name.label': 'Display name',
        'team.workspace.name.save': 'Save',
        'team.members.owner': 'Workspace owner',
        'team.guides.title': 'Role guides',
        'team.guides.body': 'Read the guide.',
        'team.guides.admin': 'Admin guide',
        'team.guides.owner': 'Owner guide',
        'analyticsConsent.settings.title': 'Analytics',
        'analyticsConsent.settings.description': 'Analytics settings.',
        'analyticsConsent.status.denied': 'Opted out.',
        'analyticsConsent.settings.on': 'On',
        'analyticsConsent.settings.off': 'Off',
      })[key] ?? key,
  }),
}))
vi.mock('~/components/form/settings-page', () => ({
  SettingsPage: ({ children }: { children: ReactNode }) => (
    <main>{children}</main>
  ),
}))
vi.mock('~/components/form/settings-section', () => ({
  SettingsSection: ({
    title,
    children,
  }: {
    title: string
    children: ReactNode
  }) => (
    <section>
      <h2>{title}</h2>
      {children}
    </section>
  ),
}))
vi.mock('./+components/team-user', () => ({
  TeamUser: ({ name, email }: { name: string; email: string }) => (
    <div>
      {name} {email}
    </div>
  ),
}))

import { action, default as GeneralPage } from './general'

function postForm(fields: Record<string, string>) {
  return new Request('https://artifactshare.com/settings/general', {
    method: 'POST',
    body: new URLSearchParams(fields),
  })
}

function renderPage(currentUserIsAdmin: boolean) {
  pageState.context = {
    workspace: { name: 'Example' },
    currentUserIsAdmin,
    currentUserRole: 'admin',
  }
  return renderToStaticMarkup(
    <GeneralPage
      {...({
        loaderData: {
          owner: { name: 'Owner', email: 'owner@example.com' },
        },
      } as Parameters<typeof GeneralPage>[0])}
    />,
  )
}

describe('/settings/general action', () => {
  test.each(['ok', 'forbidden', 'invalid'] as const)(
    'redirects %s',
    async (kind) => {
      if (kind !== 'invalid')
        services.updateWorkspaceName.mockResolvedValue({ kind })
      const response = await action({
        request: postForm(
          kind === 'invalid'
            ? { intent: 'wrong' }
            : {
                intent: 'update-workspace-name',
                workspaceName: 'New name',
              },
        ),
        context: new Map(),
      } as never)
      expect(response.headers.get('Location')).toBe(
        `/settings/general?status=${kind}`,
      )
    },
  )
})

describe('/settings/general rendered page', () => {
  test('disables workspace name controls for non-admins', () => {
    const html = renderPage(false)
    expect(html).toMatch(/id="workspace-name"[^>]*disabled/)
    expect(html).toMatch(/type="submit"[^>]*disabled/)
    expect(html).not.toContain('Role guides')
  })

  test('orders display name, owner, and role guides for admins', () => {
    const html = renderPage(true)
    expect(html.indexOf('Display name')).toBeLessThan(
      html.indexOf('Workspace owner'),
    )
    expect(html.indexOf('Workspace owner')).toBeLessThan(
      html.indexOf('Role guides'),
    )
  })

  test('shows the personal analytics section outside the admin gate', () => {
    // Consent is a per-browser personal setting, so it must render for
    // non-admins too (unlike the workspace-name / role-guide sections).
    const html = renderPage(false)
    expect(html).toContain('<h2>Analytics</h2>')
    expect(html).toContain('Opted out.')
    expect(html).toContain('>On</button>')
    expect(html).toContain('>Off</button>')
  })
})
