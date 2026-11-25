import { describe, expect, test } from 'vitest'
import { expectLocalePair } from '~/test/locale-documents'
import {
  loader as adminLoader,
  meta as adminMeta,
} from './_public/($locale)/guides.workspace-admin'
import {
  loader as ownerLoader,
  meta as ownerMeta,
} from './_public/($locale)/guides.workspace-owner'

describe('workspace role guides', () => {
  test('serves each locale its own document with locale-aware cross-links', () => {
    const owner = {
      en: ownerLoader({ params: {} } as never),
      ja: ownerLoader({ params: { locale: 'ja' } } as never),
    }
    const admin = {
      en: adminLoader({ params: {} } as never),
      ja: adminLoader({ params: { locale: 'ja' } } as never),
    }

    expectLocalePair(owner.en.html, owner.ja.html)
    expectLocalePair(admin.en.html, admin.ja.html)
    expect(owner.en.html).toContain('"/guides/workspace-admin"')
    expect(owner.ja.html).toContain('"/ja/guides/workspace-admin"')
    expect(admin.en.html).toContain('"/guides/workspace-owner"')
    expect(admin.ja.html).toContain('"/ja/guides/workspace-owner"')
  })

  test('publishes canonical and alternate locale metadata', () => {
    const expected = [
      {
        loader: adminLoader,
        meta: adminMeta,
        path: 'workspace-admin',
      },
      {
        loader: ownerLoader,
        meta: ownerMeta,
        path: 'workspace-owner',
      },
    ]
    for (const guide of expected) {
      for (const locale of ['en', 'ja'] as const) {
        const params = locale === 'ja' ? { locale } : {}
        const tags = guide.meta({
          loaderData: guide.loader({ params } as never),
        } as never)
        const prefix = locale === 'ja' ? '/ja' : ''
        expect(tags).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              tagName: 'link',
              rel: 'canonical',
              href: `https://artifactshare.com${prefix}/guides/${guide.path}`,
            }),
            expect.objectContaining({ hrefLang: 'en' }),
            expect.objectContaining({ hrefLang: 'ja' }),
            expect.objectContaining({ hrefLang: 'x-default' }),
          ]),
        )
      }
    }
  })
})
