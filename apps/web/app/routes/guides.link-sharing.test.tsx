import { describe, expect, test } from 'vitest'
import { loader as enLoader, meta as enMeta } from './guides.link-sharing'
import { loader as jaLoader } from './ja.guides.link-sharing'

describe('link sharing guide', () => {
  test('renders the canonical English and Japanese public copy', () => {
    const en = enLoader()
    const ja = jaLoader()

    expect(en.html).toContain('Share a link that opens without sign-in')
    expect(en.html).toContain('--link-expires-at &lt;RFC3339 UTC&gt;')
    expect(en.html).toContain('link_expires_at')
    expect(ja.html).toContain('ログインなしで見られるリンクを共有する')
    expect(ja.html).toContain('--no-link-expiry')
    expect(ja.html).toContain(
      'Freeでは、リンク共有と社外メンバーからの投稿を利用できません。',
    )
  })

  test('publishes canonical and alternate locale metadata', () => {
    expect(enMeta({ loaderData: enLoader() } as never)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          tagName: 'link',
          rel: 'canonical',
          href: 'https://artifactshare.com/guides/link-sharing',
        }),
        expect.objectContaining({ hrefLang: 'ja' }),
      ]),
    )
  })
})
