import { expect, test } from 'vitest'
import { loader, meta } from './_public/($locale)/guides.search'

test.each(['en', 'ja'] as const)(
  'renders search instructions in %s',
  (locale) => {
    const { html } = loader({
      params: locale === 'ja' ? { locale } : {},
    } as never)
    for (const key of ['⌘K / Ctrl+K', '/', 'Enter', 'IME'])
      expect(html).toContain(key)
    const facts =
      locale === 'en'
        ? [
            'for all members',
            'Owner',
            'Project',
            'Period',
            'Updated date',
            'Last viewed by me',
            'without selecting a suggestion',
            'arrow keys',
            'adds a search condition',
            'opens that file',
            'reruns that search',
            'Admin rights alone do not make a file appear',
          ]
        : [
            'すべてのメンバー向け',
            '所有者',
            'プロジェクト',
            '期間',
            '更新日',
            '自分が最後に見た日',
            '候補を選ばずに',
            '矢印キー',
            '検索条件に追加',
            'そのファイルを開き',
            'その検索をもう一度',
            '管理者権限だけで開けるファイルは、検索には出ません',
          ]
    for (const fact of facts) expect(html).toContain(fact)
  },
)

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
