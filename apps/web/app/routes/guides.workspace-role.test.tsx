import { describe, expect, test } from 'vitest'
import {
  loader as adminLoader,
  meta as adminMeta,
} from './_public/($locale)/guides.workspace-admin'
import {
  loader as ownerLoader,
  meta as ownerMeta,
} from './_public/($locale)/guides.workspace-owner'

describe('workspace role guides', () => {
  test('renders independently understandable English guides with cross-links', () => {
    const owner = ownerLoader({ params: {} } as never)
    const admin = adminLoader({ params: {} } as never)
    expect(owner.html).toContain('one active owner')
    expect(owner.html).toContain('Billing stays with the owner')
    expect(owner.html).toContain('/guides/workspace-admin')
    expect(admin.html).toContain('Admins keep the workspace running')
    expect(admin.html).toContain('Admins cannot manage checkout')
    expect(admin.html).toContain('/guides/workspace-owner')
  })

  test('renders independently understandable Japanese guides with cross-links', () => {
    const owner = ownerLoader({ params: { locale: 'ja' } } as never)
    const admin = adminLoader({ params: { locale: 'ja' } } as never)
    expect(owner.html).toContain('ワークスペースの最終責任')
    expect(owner.html).toContain('/ja/guides/workspace-admin')
    expect(admin.html).toContain('ワークスペースの日々の運用')
    expect(admin.html).toContain('管理者は、プランの申し込みや変更')
    expect(admin.html).toContain('/ja/guides/workspace-owner')
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
