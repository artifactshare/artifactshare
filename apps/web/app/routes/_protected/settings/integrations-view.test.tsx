import { TooltipProvider } from '~/components/ui/tooltip'
import { renderToStaticMarkup } from 'react-dom/server'
import { createMemoryRouter, Outlet, RouterProvider } from 'react-router'
import { expect, test, vi } from 'vitest'
import { bindI18n } from '~/lib/i18n'
import IntegrationsPage from './integrations'

vi.mock('cloudflare:workers', () => ({ env: {} }))
vi.mock('~/hooks/use-t', () => ({ useT: () => bindI18n('en') }))

test.each(['empty', 'connected', 'reauthorization'])(
  'members see admin guidance in the %s Slack state without a tooltip',
  (state) => {
    const router = createMemoryRouter([
      {
        path: '/',
        element: <Outlet context={{ currentUserIsAdmin: false }} />,
        children: [
          {
            index: true,
            element: (
              <IntegrationsPage
                loaderData={{
                  connections:
                    state === 'empty'
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
    expect(html).toContain(
      'Ask a workspace admin to connect or update the Slack connection.',
    )
    expect(
      html.match(
        /Ask a workspace admin to connect or update the Slack connection\./g,
      ),
    ).toHaveLength(1)
    if (state === 'reauthorization')
      expect(html).toContain(
        'Slack needs authorization again. Ask a workspace admin to reauthorize the connection.',
      )
    expect(html).not.toContain('role="tooltip"')
    expect(html).toContain('disabled=""')
    router.dispose()
  },
)
