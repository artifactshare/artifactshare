import { expect, test } from 'vitest'
import { expectLocalePair } from '~/test/locale-documents'
import { loader, meta } from './_public/($locale)/guides.search'

test('serves each locale its own document', () => {
  const en = loader({ params: {} } as never)
  const ja = loader({ params: { locale: 'ja' } } as never)

  expect(en.locale).toBe('en')
  expect(ja.locale).toBe('ja')
  expectLocalePair(en.html, ja.html)
})

test('publishes canonical and alternate locale metadata', () => {
  const expected = [
    {
      params: {},
      title: 'Search guide',
      canonical: 'https://artifactshare.com/guides/search',
    },
    {
      params: { locale: 'ja' },
      title: '検索ガイド',
      canonical: 'https://artifactshare.com/ja/guides/search',
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
