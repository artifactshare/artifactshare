import { Window } from 'happy-dom'
import { TooltipProvider } from '~/components/ui/tooltip'
import { renderToStaticMarkup } from 'react-dom/server'
import { createMemoryRouter, Outlet, RouterProvider } from 'react-router'
import { expect, test, vi } from 'vitest'
import { bindI18n, t } from '~/lib/i18n'
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
    // Entities in the rendered markup differ from the catalog text, so the
    // copy is compared on the parsed text.
    const doc = new Window().document
    doc.body.innerHTML = html
    const text = doc.body.textContent
    if (state === 'admin-empty') {
      expect(html).toContain('href="/integrations/slack/install"')
      expect(text).toContain(t('en', 'team.integrations.slack.empty'))
      router.dispose()
      return
    }
    const guidance = t('en', 'team.integrations.slack.memberGuidance')
    expect(text.split(guidance).length - 1).toBe(1)
    if (state === 'empty') {
      expect(text).toContain(t('en', 'team.integrations.slack.memberEmpty'))
      expect(html).not.toContain('href="/integrations/slack/install"')
    }
    if (state === 'reauthorization')
      expect(text).toContain(
        t('en', 'team.integrations.slack.reauthorization.memberBody'),
      )
    expect(html).not.toContain('role="tooltip"')
    expect(html).toContain('disabled=""')
    router.dispose()
  },
)
