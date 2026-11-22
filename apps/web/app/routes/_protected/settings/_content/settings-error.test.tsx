import { renderToStaticMarkup } from 'react-dom/server'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { test, expect } from 'vitest'
import { MESSAGES, SUPPORTED_LOCALES } from '~/i18n/messages'
import { ErrorBoundary } from './_layout'

test.each(SUPPORTED_LOCALES)(
  'shows a localized explanation and one recovery link in %s',
  (locale) => {
    for (const [status, key] of [
      [403, 'forbidden'],
      [404, 'missing'],
      [500, 'unexpected'],
    ] as const) {
      const router = createMemoryRouter(
        [
          {
            id: 'root',
            path: '/',
            element: (
              <ErrorBoundary
                error={{
                  status,
                  statusText: 'private',
                  internal: false,
                  data: 'private',
                }}
              />
            ),
          },
        ],
        { hydrationData: { loaderData: { root: { locale } } } },
      )
      const html = renderToStaticMarkup(<RouterProvider router={router} />)
      expect(html).toContain(MESSAGES[locale][`settings.error.${key}.title`])
      expect(html).toContain(
        MESSAGES[locale][`settings.error.${key}.description`],
      )
      expect(html).toContain(MESSAGES[locale]['settings.error.back'])
      expect(html.match(/href="[^"]+"/g)).toEqual(['href="/settings"'])
      expect(html).not.toContain('private')
      router.dispose()
    }
  },
)
