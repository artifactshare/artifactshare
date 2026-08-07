import { describe, expect, test } from 'vitest'
import {
  loader as adminLoader,
  meta as adminMeta,
} from './guides.workspace-admin'
import {
  loader as ownerLoader,
  meta as ownerMeta,
} from './guides.workspace-owner'
import { loader as jaAdminLoader } from './ja.guides.workspace-admin'
import { loader as jaOwnerLoader } from './ja.guides.workspace-owner'

describe('workspace role guides', () => {
  test('renders independently understandable English guides with cross-links', () => {
    const owner = ownerLoader()
    const admin = adminLoader()
    expect(owner.html).toContain('one active owner')
    expect(owner.html).toContain('Billing stays with the owner')
    expect(owner.html).toContain('/guides/workspace-admin')
    expect(admin.html).toContain('Admins keep the workspace running')
    expect(admin.html).toContain('Admins cannot manage checkout')
    expect(admin.html).toContain('/guides/workspace-owner')
  })

  test('renders independently understandable Japanese guides with cross-links', () => {
    const owner = jaOwnerLoader()
    const admin = jaAdminLoader()
    expect(owner.html).toContain('ワークスペースの最終責任')
    expect(owner.html).toContain('/ja/guides/workspace-admin')
    expect(admin.html).toContain('ワークスペースの日々の運用')
    expect(admin.html).toContain('管理者は、プランの申し込みや変更')
    expect(admin.html).toContain('/ja/guides/workspace-owner')
  })

  test('publishes canonical and alternate locale metadata', () => {
    expect(adminMeta({ loaderData: adminLoader() } as never)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          tagName: 'link',
          rel: 'canonical',
          href: 'https://artifactshare.com/guides/workspace-admin',
        }),
        expect.objectContaining({ hrefLang: 'ja' }),
      ]),
    )
    expect(ownerMeta({ loaderData: ownerLoader() } as never)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          tagName: 'link',
          rel: 'canonical',
          href: 'https://artifactshare.com/guides/workspace-owner',
        }),
      ]),
    )
  })
})
