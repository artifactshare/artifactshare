import { describe, expect, test, vi } from 'vitest'

import { getLatestVisibleNotice } from './updates-visibility.server'

// 実際にコミット済みの entries を使う統合テスト。updates-content.server は
// モックせず、cloudflare:workers の env だけ差し替える。
vi.mock('cloudflare:workers', () => ({
  env: { APP_ENV: 'development' },
}))

describe('viewer-list notice entry', () => {
  test('getLatestVisibleNotice returns the viewer-list entry on its release day', async () => {
    const now = new Date('2026-08-19T12:00:00Z')
    await expect(getLatestVisibleNotice('en', {}, now)).resolves.toMatchObject({
      slug: '2026-08-19-viewer-list',
      notice: true,
    })
    await expect(getLatestVisibleNotice('ja', {}, now)).resolves.toMatchObject({
      slug: '2026-08-19-viewer-list',
      notice: true,
    })
  })
})
