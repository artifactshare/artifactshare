import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router'
import { describe, expect, test, vi } from 'vitest'

import { GettingStartedPage } from '~/components/app/getting-started-page'
import { gettingStartedMeta } from '~/lib/getting-started-meta'
import { loader } from './start'

vi.mock('~/components/app/public-footer', () => ({
  PublicFooter: () => <footer data-slot="public-footer" />,
}))

vi.mock('~/hooks/use-t', () => ({
  useT: () => ({ locale: 'en', t: (key: string) => key }),
}))

describe('/start', () => {
  test.each([
    [
      'en',
      'https://artifactshare.com/start',
      'https://artifactshare.com/ja/start',
    ],
    [
      'ja',
      'https://artifactshare.com/ja/start',
      'https://artifactshare.com/start',
    ],
  ] as const)(
    '%s publishes paired metadata',
    (locale, canonical, alternate) => {
      const tags = gettingStartedMeta(locale)

      expect(tags).toContainEqual({
        tagName: 'link',
        rel: 'canonical',
        href: canonical,
      })
      expect(tags).toContainEqual({
        tagName: 'link',
        rel: 'alternate',
        hrefLang: 'en',
        href: 'https://artifactshare.com/start',
      })
      expect(tags).toContainEqual({
        tagName: 'link',
        rel: 'alternate',
        hrefLang: 'ja',
        href: locale === 'ja' ? canonical : alternate,
      })
      expect(tags).toContainEqual({
        tagName: 'link',
        rel: 'alternate',
        hrefLang: 'x-default',
        href: 'https://artifactshare.com/start',
      })
      expect(tags).toContainEqual({
        name: 'twitter:card',
        content: 'summary_large_image',
      })
      expect(tags).toContainEqual({
        property: 'og:image',
        content: 'https://artifactshare.com/og-image',
      })
    },
  )

  test.each([
    [false, '/sign-in?intent=upload&next=%2F%3Fupload%3D1'],
    [true, '/?upload=1'],
  ] as const)(
    'uses the Web upload destination for signedIn=%s',
    (signedIn, href) => {
      const html = renderToStaticMarkup(
        <MemoryRouter>
          <GettingStartedPage locale="en" signedIn={signedIn} />
        </MemoryRouter>,
      )

      expect(html).toContain(`href="${href.replaceAll('&', '&amp;')}"`)
      expect(html).toContain('Set up the CLI')
      expect(html).toContain('Connect MCP')
      expect(html).toContain('data-slot="public-footer"')
    },
  )

  test('keeps CLI and MCP links in Japanese', () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <GettingStartedPage locale="ja" signedIn />
      </MemoryRouter>,
    )

    expect(html).toContain('href="/ja/connect#ai-agents"')
    expect(html).toContain('href="/ja/connect"')
    expect(html).toContain('ファイルを共有して、共有リンクを受け取る')
  })

  test('loader exposes locale and sign-in state only', () => {
    const context = new Map()
    expect(loader({ context } as never)).toEqual({
      locale: 'en',
      signedIn: false,
    })
  })
})
