import assert from 'node:assert/strict'
import test from 'node:test'
import {
  auditAiSearchEligibility,
  compareLanguageSets,
  main,
  parseArgs,
  parseSitemap,
} from './audit-ai-search-eligibility.mjs'

const baseUrl = 'https://example.test'
const sitemap = `<?xml version="1.0"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">
  <url>
    <loc>https://example.test/</loc>
  </url>
  <url>
    <loc>https://example.test/about</loc>
    <xhtml:link rel="alternate" hreflang="en" href="https://example.test/about" />
    <xhtml:link rel="alternate" hreflang="ja" href="https://example.test/ja/about" />
    <xhtml:link rel="alternate" hreflang="x-default" href="https://example.test/about" />
  </url>
  <url>
    <loc>https://example.test/ja/about</loc>
    <xhtml:link rel="alternate" hreflang="en" href="https://example.test/about" />
    <xhtml:link rel="alternate" hreflang="ja" href="https://example.test/ja/about" />
    <xhtml:link rel="alternate" hreflang="x-default" href="https://example.test/about" />
  </url>
</urlset>`

function page(
  url,
  {
    canonical = url,
    alternates = true,
    alternateUrls = {
      en: 'https://example.test/about',
      ja: 'https://example.test/ja/about',
      'x-default': 'https://example.test/about',
    },
    noindex = false,
    robotsContent,
    xRobotsTag,
  } = {},
) {
  const alternateLinks = alternates
    ? Object.entries(alternateUrls)
        .map(
          ([language, href]) =>
            `<link rel="alternate" hreflang="${language}" href="${href}">`,
        )
        .join('')
    : ''
  const robotsDirective = robotsContent ?? (noindex ? 'noindex' : '')
  const robotsTag = robotsDirective
    ? `<meta name="robots" content="${robotsDirective}">`
    : ''
  return new Response(
    `<html><head><link rel="canonical" href="${canonical}">${alternateLinks}${robotsTag}</head></html>`,
    {
      status: 200,
      headers: {
        'content-type': 'text/html',
        ...(xRobotsTag ? { 'x-robots-tag': xRobotsTag } : {}),
      },
    },
  )
}

function fetchFromResponses(responses) {
  const seen = []
  return {
    seen,
    fetchImpl: (url, init) => {
      seen.push({
        url: url.toString(),
        redirect: init.redirect,
        userAgent: init.headers['User-Agent'],
        signal: init.signal,
      })
      const response = responses[url.toString()]
      if (!response) throw new Error(`unexpected URL: ${url}`)
      return response
    },
  }
}

test('audits a valid sitemap and every listed HTML page', async () => {
  const responses = {
    'https://example.test/sitemap.xml': new Response(sitemap, { status: 200 }),
    'https://example.test/': page('https://example.test/', {
      alternates: false,
    }),
    'https://example.test/about': page('https://example.test/about'),
    'https://example.test/ja/about': page('https://example.test/ja/about'),
  }
  const injected = fetchFromResponses(responses)

  const result = await auditAiSearchEligibility({ baseUrl, ...injected })

  assert.deepEqual(result.mismatches, [])
  assert.equal(injected.seen.length, 4)
  assert.ok(
    injected.seen.every((request) => request.userAgent === 'OAI-SearchBot'),
  )
  assert.ok(injected.seen.every((request) => request.redirect === 'manual'))
  assert.ok(
    injected.seen.every((request) => request.signal instanceof AbortSignal),
  )
})

test('detects none in meta robots and X-Robots-Tag directives', async () => {
  const injected = fetchFromResponses({
    'https://example.test/sitemap.xml': new Response(sitemap, { status: 200 }),
    'https://example.test/': page('https://example.test/', {
      alternates: false,
      robotsContent: 'none, follow',
    }),
    'https://example.test/about': page('https://example.test/about', {
      xRobotsTag: 'none, follow',
    }),
    'https://example.test/ja/about': page('https://example.test/ja/about'),
  })

  const result = await auditAiSearchEligibility({ baseUrl, ...injected })

  assert.ok(
    result.mismatches.some((item) =>
      item.includes('meta robots: none, follow'),
    ),
  )
  assert.ok(
    result.mismatches.some((item) =>
      item.includes('X-Robots-Tag: none, follow'),
    ),
  )
})

test('fetches sitemap locations on the selected base origin', async () => {
  const stagingUrl = 'http://staging.example.test'
  const productionUrl = 'https://production.example.test'
  const productionAbout = `${productionUrl}/about?preview=1`
  const productionJapaneseAbout = `${productionUrl}/ja/about`
  const stagingSitemap = sitemap
    .replaceAll(baseUrl, productionUrl)
    .replaceAll(`${productionUrl}/about`, productionAbout)
  const alternateUrls = {
    en: productionAbout,
    ja: productionJapaneseAbout,
    'x-default': productionAbout,
  }
  const injected = fetchFromResponses({
    [`${stagingUrl}/sitemap.xml`]: new Response(stagingSitemap, {
      status: 200,
    }),
    [`${stagingUrl}/`]: page(`${productionUrl}/`, { alternates: false }),
    [`${stagingUrl}/about?preview=1`]: page(productionAbout, {
      alternateUrls,
    }),
    [`${stagingUrl}/ja/about`]: page(productionJapaneseAbout, {
      alternateUrls,
    }),
  })

  const result = await auditAiSearchEligibility({
    baseUrl: stagingUrl,
    ...injected,
  })

  assert.deepEqual(result.mismatches, [])
  assert.deepEqual(
    injected.seen.map((request) => request.url),
    [
      `${stagingUrl}/sitemap.xml`,
      `${stagingUrl}/`,
      `${stagingUrl}/about?preview=1`,
      `${stagingUrl}/ja/about`,
    ],
  )
  assert.ok(
    injected.seen.every((request) => !request.url.startsWith(productionUrl)),
  )
  assert.equal(result.entries[1].loc, productionAbout)
})

test('requires exact reciprocal hreflang mappings', () => {
  const crossedEntries = [
    { loc: `${baseUrl}/`, alternates: {} },
    {
      loc: `${baseUrl}/about`,
      alternates: {
        en: `${baseUrl}/about`,
        ja: `${baseUrl}/ja/other`,
        'x-default': `${baseUrl}/about`,
      },
    },
    {
      loc: `${baseUrl}/other`,
      alternates: {
        en: `${baseUrl}/other`,
        ja: `${baseUrl}/ja/about`,
        'x-default': `${baseUrl}/other`,
      },
    },
    {
      loc: `${baseUrl}/ja/about`,
      alternates: {
        en: `${baseUrl}/about`,
        ja: `${baseUrl}/ja/about`,
        'x-default': `${baseUrl}/about`,
      },
    },
    {
      loc: `${baseUrl}/ja/other`,
      alternates: {
        en: `${baseUrl}/other`,
        ja: `${baseUrl}/ja/other`,
        'x-default': `${baseUrl}/other`,
      },
    },
  ]
  const mismatches = compareLanguageSets(crossedEntries)

  assert.ok(
    mismatches.some((item) =>
      item.includes('non-reciprocal Japanese alternate'),
    ),
  )
  assert.ok(
    mismatches.some((item) =>
      item.includes('non-reciprocal English alternate'),
    ),
  )
})

test('collects multiple sitemap and HTML mismatches before returning', async () => {
  const brokenSitemap = sitemap.replace(
    'https://example.test/ja/about</loc>',
    'https://example.test/ja/missing</loc>',
  )
  const responses = {
    'https://example.test/sitemap.xml': new Response(brokenSitemap, {
      status: 200,
    }),
    'https://example.test/': new Response('<html></html>', {
      status: 503,
      headers: { 'x-robots-tag': 'noindex' },
    }),
    'https://example.test/about': page('https://example.test/other', {
      noindex: true,
    }),
    'https://example.test/ja/missing': page('https://example.test/ja/missing', {
      alternates: false,
    }),
  }
  const result = await auditAiSearchEligibility({
    baseUrl,
    ...fetchFromResponses(responses),
  })

  assert.ok(result.mismatches.length >= 6)
  assert.ok(
    result.mismatches.some((item) =>
      item.includes('expected HTTP 2xx, got 503'),
    ),
  )
  assert.ok(result.mismatches.some((item) => item.includes('noindex present')))
  assert.ok(result.mismatches.some((item) => item.includes('canonical is')))
  assert.ok(
    result.mismatches.some((item) => item.includes('missing ja alternate')),
  )
  assert.ok(
    result.mismatches.some((item) => item.includes('missing self canonical')),
  )
})

test('reports sitemap redirects without following them', async () => {
  const redirectTarget = 'https://example.test/sitemap-final.xml'
  const injected = fetchFromResponses({
    'https://example.test/sitemap.xml': new Response(null, {
      status: 302,
      headers: { location: redirectTarget },
    }),
  })

  const result = await auditAiSearchEligibility({ baseUrl, ...injected })

  assert.ok(
    result.mismatches.some((item) =>
      item.includes('sitemap.xml: expected HTTP 2xx, got 302'),
    ),
  )
  assert.deepEqual(
    injected.seen.map((request) => request.url),
    ['https://example.test/sitemap.xml'],
  )
})

test('reports page redirects without following them', async () => {
  const redirectTarget = 'https://example.test/about-final'
  const injected = fetchFromResponses({
    'https://example.test/sitemap.xml': new Response(sitemap, { status: 200 }),
    'https://example.test/': page('https://example.test/', {
      alternates: false,
    }),
    'https://example.test/about': new Response(null, {
      status: 301,
      headers: { location: redirectTarget },
    }),
    'https://example.test/ja/about': page('https://example.test/ja/about'),
  })

  const result = await auditAiSearchEligibility({ baseUrl, ...injected })

  assert.ok(
    result.mismatches.some((item) =>
      item.includes('about: expected HTTP 2xx, got 301'),
    ),
  )
  assert.deepEqual(
    injected.seen.map((request) => request.url),
    [
      'https://example.test/sitemap.xml',
      'https://example.test/',
      'https://example.test/about',
      'https://example.test/ja/about',
    ],
  )
})

test('aborts timed out pages and continues auditing remaining URLs', async () => {
  const seen = []
  const aborted = []
  const responses = {
    'https://example.test/sitemap.xml': new Response(sitemap, { status: 200 }),
    'https://example.test/': page('https://example.test/', {
      alternates: false,
    }),
    'https://example.test/ja/about': page('https://example.test/ja/about'),
  }
  const fetchImpl = (url, init) => {
    const requestUrl = url.toString()
    seen.push({ url: requestUrl, signal: init.signal })
    if (requestUrl === 'https://example.test/about') {
      return new Promise((resolve, reject) => {
        init.signal.addEventListener(
          'abort',
          () => {
            aborted.push(requestUrl)
            reject(new Error('request aborted'))
          },
          { once: true },
        )
      })
    }
    return responses[requestUrl]
  }

  const result = await auditAiSearchEligibility({
    baseUrl,
    fetchImpl,
    timeoutMs: 1,
  })

  assert.ok(
    result.mismatches.includes(
      'https://example.test/about: fetch failed: request aborted',
    ),
  )
  assert.deepEqual(aborted, ['https://example.test/about'])
  assert.deepEqual(
    seen.map((request) => request.url),
    [
      'https://example.test/sitemap.xml',
      'https://example.test/',
      'https://example.test/about',
      'https://example.test/ja/about',
    ],
  )
  assert.ok(seen.every((request) => request.signal instanceof AbortSignal))
})

test('aborts timed out response bodies and continues auditing remaining URLs', async () => {
  const seen = []
  let pageSignal
  const responses = {
    'https://example.test/sitemap.xml': new Response(sitemap, { status: 200 }),
    'https://example.test/': page('https://example.test/', {
      alternates: false,
    }),
    'https://example.test/ja/about': page('https://example.test/ja/about'),
  }
  const fetchImpl = (url, init) => {
    const requestUrl = url.toString()
    seen.push(requestUrl)
    if (requestUrl === 'https://example.test/about') {
      pageSignal = init.signal
      return {
        status: 200,
        headers: new Headers(),
        text: () =>
          new Promise((resolve, reject) => {
            init.signal.addEventListener(
              'abort',
              () => reject(new Error('body aborted')),
              { once: true },
            )
          }),
      }
    }
    return responses[requestUrl]
  }

  const result = await auditAiSearchEligibility({
    baseUrl,
    fetchImpl,
    timeoutMs: 1,
  })

  assert.equal(pageSignal.aborted, true)
  assert.ok(
    result.mismatches.includes(
      'https://example.test/about: fetch failed: body aborted',
    ),
  )
  assert.deepEqual(seen, [
    'https://example.test/sitemap.xml',
    'https://example.test/',
    'https://example.test/about',
    'https://example.test/ja/about',
  ])
})

test('parses a positive CLI timeout', () => {
  assert.equal(parseArgs(['--timeout-ms', '250']).timeoutMs, 250)
  assert.throws(() => parseArgs(['--timeout-ms', '0']), /positive integer/)
})

test('returns a non-zero code after printing all mismatches', async () => {
  const result = await main(['--base-url', baseUrl], {
    fetchImpl: () => new Response('<urlset></urlset>', { status: 200 }),
  })
  assert.equal(result, 1)
})

test('parses XML locations and alternate links', () => {
  const entries = parseSitemap(
    '<url><loc>https://example.test/a&amp;b</loc><xhtml:link rel="alternate" hreflang="en" href="/a&amp;b" /></url>',
  )
  assert.deepEqual(entries, [
    {
      loc: 'https://example.test/a&b',
      alternates: { en: '/a&b' },
    },
  ])
})

test('rejects relative sitemap locations instead of resolving them', () => {
  const entries = parseSitemap('<url><loc>/about</loc></url>')

  assert.ok(
    compareLanguageSets(entries).some((item) =>
      item.includes('/about: invalid sitemap URL'),
    ),
  )
})
