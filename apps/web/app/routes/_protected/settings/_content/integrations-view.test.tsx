import { TooltipProvider } from '~/components/ui/tooltip'
import { renderToStaticMarkup } from 'react-dom/server'
import { createMemoryRouter, Outlet, RouterProvider } from 'react-router'
import { expect, test, vi } from 'vitest'
import { bindI18n } from '~/lib/i18n'
import IntegrationsPage from './integrations'

vi.mock('cloudflare:workers', () => ({ env: {} }))
vi.mock('~/hooks/use-t', () => ({ useT: () => bindI18n('en') }))

test.each(['empty', 'admin-empty', 'connected', 'reauthorization'])(
  'Slack %s shows role-specific guidance and controls',
  (state) => {
    const router = createMemoryRouter([
      {
        path: '/',
        element: (
          <Outlet context={{ currentUserIsAdmin: state === 'admin-empty' }} />
        ),
        children: [
          {
            index: true,
            element: (
              <IntegrationsPage
                loaderData={{
                  connections: state.endsWith('empty')
                    ? []
                    : [
                        {
                          id: 'slack',
                          teamName: 'Example team',
                          installedAt: '2026-01-01T00:00:00.000Z',
                          installedByName: 'Owner',
                          needsReauthorization: state === 'reauthorization',
                        },
                      ],
                }}
              />
            ),
          },
        ],
      },
    ])
    const html = renderToStaticMarkup(
      <TooltipProvider>
        <RouterProvider router={router} />
      </TooltipProvider>,
    )
    if (state === 'admin-empty') {
      expect(html).toContain('href="/integrations/slack/install"')
      expect(html).toContain('Connect it to preview shared links')
      router.dispose()
      return
    }
    expect(html).toContain(
      'Ask a workspace admin to connect or update the Slack connection.',
    )
    expect(
      html.match(
        /Ask a workspace admin to connect or update the Slack connection\./g,
      ),
    ).toHaveLength(1)
    if (state === 'empty') {
      expect(html).toContain('Slack is not connected to this workspace.')
      expect(html).not.toContain('href="/integrations/slack/install"')
    }
    if (state === 'reauthorization')
      expect(html).toContain(
        'Slack needs authorization again. Ask a workspace admin to reauthorize the connection.',
      )
    expect(html).not.toContain('role="tooltip"')
    expect(html).toContain('disabled=""')
    router.dispose()
  },
)
