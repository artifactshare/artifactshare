import { describe, expect, test } from 'vitest'
import { loader, meta } from './_public/($locale)/guides.link-sharing'

describe('link sharing guide', () => {
  test('renders the canonical English and Japanese public copy', () => {
    const en = loader({ params: {} } as never)
    const ja = loader({ params: { locale: 'ja' } } as never)

    expect(en.html).toContain('Share a link that opens without sign-in')
    expect(en.html).toContain('--link-expires-at &lt;RFC3339 UTC&gt;')
    expect(en.html).toContain('link_expires_at')
    expect(ja.html).toContain('ログインなしで見られるリンクを共有する')
    expect(ja.html).toContain('--no-link-expiry')
    expect(ja.html).toContain('Freeでも、ファイルごとにリンク共有を選べます。')
  })

  test('publishes canonical and alternate locale metadata', () => {
    const expected = [
      {
        params: {},
        title: 'Link sharing guide',
        canonical: 'https://artifactshare.com/guides/link-sharing',
      },
      {
        params: { locale: 'ja' },
        title: 'リンク共有ガイド',
        canonical: 'https://artifactshare.com/ja/guides/link-sharing',
      },
    ]

    for (const item of expected) {
      const tags = meta({
        loaderData: loader({ params: item.params } as never),
      } as never)
      expect(tags).toEqual(
        expect.arrayContaining([
          { title: item.title },
          expect.objectContaining({
            tagName: 'link',
            rel: 'canonical',
            href: item.canonical,
          }),
          expect.objectContaining({ hrefLang: 'en' }),
          expect.objectContaining({ hrefLang: 'ja' }),
          expect.objectContaining({ hrefLang: 'x-default' }),
        ]),
      )
    }
  })
})
