import { describe, expect, test, vi } from 'vitest'
vi.mock('cloudflare:workers', () => ({ env: { APP_ENV: 'development' } }))
import {
  hasNoticed,
  mergeUpdatesNotice,
  readUpdatesNotice,
  updatesNoticePresentation,
  updatesNoticeCookieHeader,
} from './updates-notice.server'

function requestWithCookie(value: string) {
  return new Request('https://example.test/updates', {
    headers: { cookie: value },
  })
}

describe('updates notice cookie', () => {
  test('handles malformed JSON safely', () => {
    expect(
      readUpdatesNotice(requestWithCookie('__as_updates_notice=%7B')),
    ).toEqual({})
  })

  test('ignores invalid values and keeps locale-independent slugs', () => {
    expect(
      readUpdatesNotice(
        requestWithCookie(
          '__as_updates_notice=' +
            encodeURIComponent(JSON.stringify({ noticed: true, opened: 4 })),
        ),
      ),
    ).toEqual({})
    const cookie = updatesNoticeCookieHeader({ noticed: 'recently-seen-files' })
    expect(cookie).toContain('Path=/')
    expect(cookie).toContain('SameSite=Lax')
    expect(cookie).toContain('HttpOnly')
    expect(cookie).toContain('Max-Age=31536000')
    expect(cookie).toContain('recently-seen-files')
  })

  test('opening a notice records noticed and opened together', () => {
    const cookie = mergeUpdatesNotice(
      requestWithCookie(
        '__as_updates_notice=' +
          encodeURIComponent(JSON.stringify({ noticed: 'old', opened: 'old' })),
      ),
      'new-notice',
      true,
    )
    const state = readUpdatesNotice(requestWithCookie(cookie))
    expect(state).toEqual({ noticed: 'new-notice', opened: 'new-notice' })
    expect(hasNoticed(state, 'new-notice')).toBe(true)
  })

  test('does not preserve an opened slug when noticed moves to another slug', () => {
    const cookie = mergeUpdatesNotice(
      requestWithCookie(
        '__as_updates_notice=' +
          encodeURIComponent(JSON.stringify({ noticed: 'old', opened: 'old' })),
      ),
      'new-notice',
    )
    expect(readUpdatesNotice(requestWithCookie(cookie))).toEqual({
      noticed: 'new-notice',
    })
  })

  test('derives the SSR dot and NEW state from one locale-independent slug', () => {
    expect(updatesNoticePresentation({}, 'latest')).toEqual({
      slug: 'latest',
      dot: true,
      new: true,
    })
    expect(updatesNoticePresentation({ noticed: 'latest' }, 'latest')).toEqual({
      slug: 'latest',
      dot: false,
      new: true,
    })
    expect(
      updatesNoticePresentation(
        { noticed: 'latest', opened: 'latest' },
        'latest',
      ),
    ).toEqual({ slug: 'latest', dot: false, new: false })
    expect(updatesNoticePresentation({}, undefined)).toEqual({
      dot: false,
      new: false,
    })
  })
})
