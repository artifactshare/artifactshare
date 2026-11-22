import {
  createRequestHandler,
  RouterContextProvider,
  useRouteError,
} from 'react-router'
import { Window } from 'happy-dom'
import entry from './entry.server'
import { SUPPORTED_LOCALES, MESSAGES } from '~/i18n/messages'
import { describe, expect, test, vi } from 'vitest'

vi.mock('~/middleware/auth', () => ({
  sessionMiddleware: vi.fn(),
}))
vi.mock('cloudflare:workers', () => ({
  env: {
    GA4_MEASUREMENT_ID: '',
    BETTER_AUTH_URL: 'https://artifactshare.com',
  },
}))

import {
  Layout,
  ErrorBoundary,
  isProjectTimezoneRoute,
  links,
  loader,
  shouldRevalidate,
  middleware,
} from './root'
import { linkDomainContext, userContext } from '~/middleware/context'
import { linkViewerHistoryUrl } from '~/lib/link-viewer-history'

function revalidateArgs(
  currentPath: string,
  nextPath: string,
  defaultShouldRevalidate: boolean,
) {
  return {
    currentUrl: new URL(`https://artifactshare.com${currentPath}`),
    nextUrl: new URL(`https://artifactshare.com${nextPath}`),
    defaultShouldRevalidate,
  } as Parameters<typeof shouldRevalidate>[0]
}

describe('root links', () => {
  test('advertises agent discovery documents from every HTML page', () => {
    expect(links()).toEqual(
      expect.arrayContaining([
        { rel: 'alternate', type: 'text/plain', href: '/llms.txt' },
        {
          rel: 'service-desc',
          type: 'application/json',
          href: '/.well-known/agent.json',
        },
      ]),
    )
  })
})

describe('project timezone routes', () => {
  test.each([
    [['routes/_protected/projects.$id'], true],
    [['routes/_protected/projects.$id.activity'], true],
    [
      [
        'routes/_protected/projects.$id',
        'routes/_protected/projects.$id.activity',
      ],
      true,
    ],
    [['routes/_protected/projects.archived'], false],
    [['routes/_protected/projects.$id.files'], false],
    [['routes/_protected/settings/_content/activity'], false],
    [[], false],
  ] as const)('%s', (routeIds, expected) => {
    expect(isProjectTimezoneRoute(routeIds.map((id) => ({ id })))).toBe(
      expected,
    )
  })
})

describe('link viewer history URL', () => {
  test('removes version while preserving other parameters and the hash', () => {
    expect(
      linkViewerHistoryUrl(
        '/',
        '?version=old&panel=comments&access-request=req-1',
        '#section',
      ),
    ).toBe('/?panel=comments&access-request=req-1#section')
  })
})

describe('root locale', () => {
  test('keeps the viewer locale when a link host is served at root', async () => {
    const context = {
      get: vi.fn((key) => {
        if (key === linkDomainContext) return { shareableId: 'abc123def4' }
        if (key === userContext) return null
        return null
      }),
    }
    const result = await loader(
      loaderArgs('https://example.test/', 'ja', context),
    )
    expect(result.locale).toBe('ja')
    expect(result.linkDomain).toBe(true)
  })

  test.each([
    ['/ja', '/', false, true],
    ['/ja/about', '/', false, true],
    ['/ja/about', '/about', false, false],
    ['/about', '/', false, false],
    ['/ja', '/?from=ja', false, true],
    ['/ja?from=previous', '/?from=ja', true, true],
  ] as const)(
    '%s → %s preserves the default unless crossing home',
    (currentPath, nextPath, defaultShouldRevalidate, expected) => {
      expect(
        shouldRevalidate(
          revalidateArgs(currentPath, nextPath, defaultShouldRevalidate),
        ),
      ).toBe(expected)
    },
  )

  test.each([
    ['https://artifactshare.com/', null, 'ja', 'en'],
    ['https://artifactshare.com/', { locale: 'ja' }, 'en', 'ja'],
    ['https://artifactshare.com/?next=/a/example', null, 'ja', 'ja'],
    ['https://artifactshare.com/?next=/pricing', null, 'ja', 'en'],
    ['https://artifactshare.com/?next=/', null, 'ja', 'en'],
    [
      'https://artifactshare.com/?next=https%3A%2F%2Fevil.com',
      null,
      'ja',
      'en',
    ],
    ['https://artifactshare.com/ja', { locale: 'en' }, 'en', 'ja'],
  ] as const)('classifies %s', async (url, user, acceptLanguage, expected) => {
    const context = {
      get: vi.fn((key) => (key === userContext ? user : null)),
    }
    expect(
      (await loader(loaderArgs(url, acceptLanguage, context))).locale,
    ).toBe(expected)
  })
  // Client navigations arrive as "<path>.data". Reading the raw request URL
  // here would treat the path as unknown and drop the path-forced locale.
  test('keeps the path-forced locale when the request arrives as a data request', async () => {
    const context = { get: vi.fn(() => null) }
    expect(
      (
        await loader(
          loaderArgs(
            'https://artifactshare.com/ja/share-with-ai',
            'en',
            context,
            undefined,
            undefined,
            'https://artifactshare.com/ja/share-with-ai.data',
          ),
        )
      ).locale,
    ).toBe('ja')
  })

  test('keeps the share-with-ai path locale when lang query is unsupported', async () => {
    const context = { get: vi.fn(() => null) }

    expect(
      (
        await loader(
          loaderArgs(
            'https://artifactshare.com/ja/share-with-ai?lang=foo',
            'en',
            context,
          ),
        )
      ).locale,
    ).toBe('ja')

    expect(
      (
        await loader(
          loaderArgs(
            'https://artifactshare.com/share-with-ai?lang=foo',
            'ja',
            context,
          ),
        )
      ).locale,
    ).toBe('en')

    expect(
      (
        await loader(
          loaderArgs(
            'https://artifactshare.com/ja/share-with-ai/',
            'en',
            context,
          ),
        )
      ).locale,
    ).toBe('ja')
  })
})

describe('root analytics consent', () => {
  test('gates unknown regions with no stored choice as consent-required', async () => {
    const context = { get: vi.fn(() => null) }
    expect(
      (await loader(loaderArgs('https://artifactshare.com/', 'en', context)))
        .analyticsConsent,
    ).toEqual({
      state: 'unset',
      region: 'consent-required',
      shouldLoadAnalytics: false,
      showBanner: true,
    })
  })

  test('honours a stored granted choice', async () => {
    const context = { get: vi.fn(() => null) }
    const result = (
      await loader(
        loaderArgs('https://artifactshare.com/', 'en', context, {
          cookie: '__as_analytics_consent=granted',
        }),
      )
    ).analyticsConsent
    expect(result.state).toBe('granted')
    expect(result.shouldLoadAnalytics).toBe(true)
    expect(result.showBanner).toBe(false)
  })

  test('treats a known non-EU country as default-on', async () => {
    const context = { get: vi.fn(() => null) }
    const result = (
      await loader(
        loaderArgs(
          'https://artifactshare.com/',
          'en',
          context,
          undefined,
          'US',
        ),
      )
    ).analyticsConsent
    expect(result.region).toBe('default-on')
    expect(result.shouldLoadAnalytics).toBe(true)
    expect(result.showBanner).toBe(false)
  })
})

describe('root maintenance', () => {
  test('exposes the worker maintenance marker to client UI', async () => {
    const context = { get: vi.fn(() => null) }

    expect(
      (
        await loader(
          loaderArgs('https://artifactshare.com/', 'en', context, {
            'x-artifactshare-maintenance': '1',
          }),
        )
      ).maintenance,
    ).toBe(true)

    expect(
      (await loader(loaderArgs('https://artifactshare.com/', 'en', context)))
        .maintenance,
    ).toBe(false)
  })
})

describe('root screen states', () => {
  test('keeps the updates menu fixture independent of notice publication dates', async () => {
    const context = {
      get: vi.fn(() => ({ id: 'user-1', locale: null })),
    }

    const result = await loader(
      loaderArgs('https://localhost/', 'en', context, {
        'X-ArtifactShare-Dev-Screen-State': 'home/updates-menu-open',
      }),
    )

    expect(result.updatesNotice).toEqual({
      slug: 'dev-screen-updates-notice',
      dot: true,
      new: true,
    })
  })
})

function loaderArgs(
  url: string,
  acceptLanguage: string,
  context: { get: ReturnType<typeof vi.fn> },
  headers?: HeadersInit,
  cfCountry?: string,
  rawRequestUrl = url,
): Parameters<typeof loader>[0] {
  const request = new Request(rawRequestUrl, {
    headers: { 'Accept-Language': acceptLanguage, ...headers },
  })
  if (cfCountry !== undefined)
    Object.assign(request, { cf: { country: cfCountry } })
  return {
    request,
    context,
    url: new URL(url),
    params: {},
    pattern: '',
  } as unknown as Parameters<typeof loader>[0]
}

import { sandboxBlockReportMiddleware } from '~/middleware/sandbox-block-report.server'
import { sessionMiddleware } from '~/middleware/auth'
test('report admission precedes session middleware', () => {
  expect(middleware).toEqual([sandboxBlockReportMiddleware, sessionMiddleware])
})

test.each(SUPPORTED_LOCALES)(
  'renders a localized root error document in %s with and without loader data',
  async (locale) => {
    const window = new Window()
    try {
      for (const hasData of [true, false]) {
        const handler = createRequestHandler(
          {
            entry: { module: { default: entry, handleError: () => {} } },
            routes: {
              root: {
                id: 'root',
                path: '/',
                module: {
                  Layout,
                  links,
                  default: () => {
                    throw new Error('render fault')
                  },
                  ErrorBoundary: () => (
                    <ErrorBoundary error={useRouteError()} />
                  ),
                  loader: () => {
                    if (!hasData) throw new Error('loader fault')
                    return {
                      locale,
                      appOrigin: 'https://artifactshare.com',
                      analyticsConsent: { showBanner: true },
                    }
                  },
                },
              },
            },
            assets: {
              routes: {
                root: {
                  id: 'root',
                  path: '/',
                  module: 'root.js',
                  hasAction: false,
                  hasLoader: true,
                  hasClientAction: false,
                  hasClientLoader: false,
                  hasClientMiddleware: false,
                  hasErrorBoundary: true,
                  clientActionModule: undefined,
                  clientLoaderModule: undefined,
                  clientMiddlewareModule: undefined,
                  hydrateFallbackModule: undefined,
                },
              },
              entry: { module: 'entry.js', imports: [] },
              url: 'manifest.js',
              version: 'test',
            },
            publicPath: '/',
            assetsBuildDirectory: 'build/client',
            future: {},
            ssr: true,
            isSpaMode: false,
            prerender: [],
            routeDiscovery: { mode: 'initial', manifestPath: '/__manifest' },
          },
          'test',
        )
        const context = new RouterContextProvider()
        if (!hasData) context.set(linkDomainContext, { shareableId: 'example' })
        const res = await handler(
          new Request(
            hasData
              ? 'https://artifactshare.com/'
              : 'https://example.artifactshare.link/',
            {
              headers: {
                'Accept-Language': hasData
                  ? locale === 'en'
                    ? 'ja'
                    : 'en'
                  : locale,
              },
            },
          ),
          context,
        )
        const doc = new window.DOMParser().parseFromString(
          await res.text(),
          'text/html',
        )
        expect(res.status).toBe(500)
        expect(doc.documentElement.lang).toBe(locale)
        expect(doc.querySelector('main h1')?.textContent).toBe(
          MESSAGES[locale]['root.error.unexpected.title'],
        )
        expect(
          doc.querySelector('main [data-slot="empty-description"]')
            ?.textContent,
        ).toBe(MESSAGES[locale]['root.error.unexpected.description'])
        const linksOutsideConsent = Array.from(
          doc.querySelectorAll('a'),
        ).filter((link) => !link.closest('[data-analytics-consent-banner]'))
        expect(linksOutsideConsent).toHaveLength(1)
        expect(
          linksOutsideConsent[0]
            ?.closest('[data-screen-capture-error]')
            ?.getAttribute('data-screen-capture-error'),
        ).toBe('route-error-boundary')
        expect(linksOutsideConsent[0]?.getAttribute('href')).toBe(
          'https://artifactshare.com/',
        )
        expect(linksOutsideConsent[0]?.getAttribute('aria-label')).toBe(
          MESSAGES[locale]['vw.homeLink'],
        )
        expect(
          Boolean(
            doc.querySelector('[data-analytics-consent-banner][role="region"]'),
          ),
        ).toBe(hasData)
        expect(doc.querySelector('#app-topbar,nav')).toBeNull()
        expect(doc.querySelector('link[rel="icon"]')).not.toBeNull()
      }
    } finally {
      await window.happyDOM.close()
    }
  },
)
