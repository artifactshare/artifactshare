import { beforeEach, describe, expect, test, vi } from 'vitest'
import { action } from './notice-updates'

const getLatestVisibleNoticeMock = vi.hoisted(() => vi.fn())

vi.mock('~/services/updates-visibility.server', () => ({
  getLatestVisibleNotice: getLatestVisibleNoticeMock,
}))

vi.mock('cloudflare:workers', () => ({
  env: { APP_ENV: 'development' },
}))

beforeEach(() => {
  getLatestVisibleNoticeMock.mockReset()
})

describe('/notice-updates action', () => {
  test('records the latest notice without marking it opened', async () => {
    getLatestVisibleNoticeMock.mockResolvedValue({ slug: 'latest' })

    const response = await action({
      request: new Request('https://artifactshare.com/notice-updates', {
        method: 'POST',
      }),
    } as never)

    const cookie = new Headers(response.init?.headers).get('Set-Cookie')
    expect(cookie).toContain('latest')
    expect(cookie).toContain('HttpOnly')
    expect(decodeURIComponent(cookie!)).toContain('"noticed":"latest"')
    expect(decodeURIComponent(cookie!)).not.toContain('"opened"')
  })

  test('does not set a cookie when there is no current notice', async () => {
    getLatestVisibleNoticeMock.mockResolvedValue(undefined)

    const response = await action({
      request: new Request('https://artifactshare.com/notice-updates', {
        method: 'POST',
      }),
    } as never)

    expect(new Headers(response.init?.headers).get('Set-Cookie')).toBeNull()
  })
})
