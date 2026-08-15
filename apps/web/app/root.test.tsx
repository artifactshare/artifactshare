import { describe, expect, test, vi } from 'vitest'

vi.mock('~/middleware/auth', () => ({
  sessionMiddleware: vi.fn(),
}))
vi.mock('cloudflare:workers', () => ({
  env: { GA4_MEASUREMENT_ID: '' },
}))

import { links, loader, shouldRevalidate } from './root'

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

describe('root locale', () => {
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
    const context = { get: vi.fn(() => user) }
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
