import { describe, expect, test } from 'vitest'
import { loader, meta } from './guides.private-mobile-design-handoff'
import {
  loader as jaLoader,
  meta as jaMeta,
} from './ja.guides.private-mobile-design-handoff'
import {
  PRIVATE_HANDOFF_EN_CANONICAL,
  PRIVATE_HANDOFF_JA_CANONICAL,
} from '~/lib/private-mobile-design-handoff-meta'

describe('private mobile design handoff guide routes', () => {
  test('load fixed locales and SSR-ready Markdown content', () => {
    const en = loader()
    const ja = jaLoader()
    expect(en.locale).toBe('en')
    expect(ja.locale).toBe('ja')
    expect(en.source).toContain('# Keep a mobile design document private')
    expect(ja.source).toContain(
      '# モバイルの設計文書を非公開のまま PC へ引き継ぐ',
    )
    expect(en.html).toContain('<h1 id=')
    expect(en.html).toContain('<ol>')
    expect(en.source).not.toMatch(/^---/)
    expect(en.html).not.toContain('---')
    expect(en.html).toContain('https://artifactshare.com/guides/cli')
    expect(ja.html).toContain('https://artifactshare.com/ja/guides/cli')
  })

  test('publish locale-specific canonical and social metadata', () => {
    const en = meta({ loaderData: loader() } as never)
    const ja = jaMeta({ loaderData: jaLoader() } as never)
    const expected = [
      {
        tags: en,
        title: 'Keep a mobile design document private when handing it to a PC',
        ogTitle: 'Private mobile design handoff',
        description:
          'Share a mobile design document privately from an agent, then continue it on a PC. One share command with --visibility private is all it takes.',
        ogDescription:
          'Share a mobile design document privately from an agent, then continue it on a PC with a single share command.',
        canonical: PRIVATE_HANDOFF_EN_CANONICAL,
        locale: 'en_US',
        alternateLocale: 'ja_JP',
        imageAlt: 'Private mobile design handoff guide',
      },
      {
        tags: ja,
        title: 'モバイルの設計文書を非公開のまま PC へ引き継ぐ',
        ogTitle: 'モバイルの設計文書を非公開のまま PC へ引き継ぐ',
        description:
          'モバイルのエージェントから設計文書を自分だけに見える状態で共有し、PC で続きをする方法を案内します。共有コマンドに --visibility private を付けるだけで完結します。',
        ogDescription:
          'モバイルのエージェントから設計文書を非公開で共有し、PC で続きをする方法です。共有コマンド 1 つで完結します。',
        canonical: PRIVATE_HANDOFF_JA_CANONICAL,
        locale: 'ja_JP',
        alternateLocale: 'en_US',
        imageAlt: 'モバイルの設計文書を非公開のまま PC へ引き継ぐガイド',
      },
    ]

    for (const item of expected) {
      expect(item.tags).toContainEqual({ title: item.title })
      expect(item.tags).toContainEqual({
        name: 'description',
        content: item.description,
      })
      expect(item.tags).toContainEqual({
        tagName: 'link',
        rel: 'canonical',
        href: item.canonical,
      })
      expect(item.tags).toContainEqual({
        tagName: 'link',
        rel: 'alternate',
        hrefLang: 'en',
        href: PRIVATE_HANDOFF_EN_CANONICAL,
      })
      expect(item.tags).toContainEqual({
        tagName: 'link',
        rel: 'alternate',
        hrefLang: 'ja',
        href: PRIVATE_HANDOFF_JA_CANONICAL,
      })
      expect(item.tags).toContainEqual({
        tagName: 'link',
        rel: 'alternate',
        hrefLang: 'x-default',
        href: PRIVATE_HANDOFF_EN_CANONICAL,
      })
      expect(item.tags).toContainEqual({
        property: 'og:title',
        content: item.ogTitle,
      })
      expect(item.tags).toContainEqual({
        property: 'og:description',
        content: item.ogDescription,
      })
      expect(item.tags).toContainEqual({
        property: 'og:url',
        content: item.canonical,
      })
      expect(item.tags).toContainEqual({
        property: 'og:image',
        content: `${item.canonical}/og-image`,
      })
      expect(item.tags).toContainEqual({
        property: 'og:image:alt',
        content: item.imageAlt,
      })
      expect(item.tags).toContainEqual({
        property: 'og:locale',
        content: item.locale,
      })
      expect(item.tags).toContainEqual({
        property: 'og:locale:alternate',
        content: item.alternateLocale,
      })
      expect(item.tags).toContainEqual({
        name: 'twitter:title',
        content: item.ogTitle,
      })
      expect(item.tags).toContainEqual({
        name: 'twitter:description',
        content: item.ogDescription,
      })
      expect(item.tags).toContainEqual({
        name: 'twitter:image',
        content: `${item.canonical}/og-image`,
      })
      expect(item.tags).toContainEqual({
        name: 'twitter:card',
        content: 'summary_large_image',
      })
    }
  })
})
