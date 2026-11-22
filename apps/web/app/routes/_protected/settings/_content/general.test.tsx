import { renderToStaticMarkup } from 'react-dom/server'
import {
  createMemoryRouter,
  Outlet,
  RouterProvider,
  RouterContextProvider,
} from 'react-router'
import { describe, expect, test, vi } from 'vitest'

const services = vi.hoisted(() => ({ updateWorkspaceName: vi.fn() }))
vi.mock('~/services/db.server', () => ({ createDb: () => ({}) }))
vi.mock('~/middleware/context', () => ({
  requireUser: () => ({ id: 'user', workspaceId: 'workspace' }),
}))
vi.mock('~/services/dev-screen-state.server', () => ({
  isDevScreenStateRequest: () => false,
}))
vi.mock('~/services/team-management.server', () => services)
import { action, default as GeneralPage } from './general'

function postForm(fields: Record<string, string>) {
  return new Request('https://artifactshare.com/settings/general', {
    method: 'POST',
    body: new URLSearchParams(fields),
  })
}

function renderPage(currentUserIsAdmin: boolean) {
  const context = {
    workspace: { name: 'Example' },
    currentUserIsAdmin,
    currentUserRole: 'admin',
  }
  const router = createMemoryRouter([
    {
      element: <Outlet context={context} />,
      children: [
        {
          path: '/',
          element: (
            <GeneralPage
              loaderData={{
                owner: {
                  id: 'owner',
                  name: 'Owner',
                  email: 'owner@example.com',
                  image: null,
                },
              }}
            />
          ),
        },
      ],
    },
  ])
  try {
    return renderToStaticMarkup(<RouterProvider router={router} />)
  } finally {
    router.dispose()
  }
}

describe('/settings/general action', () => {
  test.each(['ok', 'forbidden', 'invalid'] as const)(
    'returns the %s submission result',
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
        context: new RouterContextProvider(),
        params: {},
        pattern: '/settings/general',
        url: new URL('https://example.test/settings/general'),
      })
      expect(response.data).toEqual({
        ok: kind === 'ok',
        code: kind,
        intent: kind === 'invalid' ? 'wrong' : 'update-workspace-name',
      })
      expect(response.init?.status).toBe(
        kind === 'ok' ? 200 : kind === 'forbidden' ? 403 : 400,
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

  test('keeps analytics outside General for non-admins', () => {
    // Consent is a per-browser personal setting, so it must render for
    // non-admins too (unlike the workspace-name / role-guide sections).
    const html = renderPage(false)
    expect(html).not.toContain('<h2>Analytics</h2>')
    expect(html).toContain('Workspace owner')
  })
})
