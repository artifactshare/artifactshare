import { describe, expect, test } from 'vitest'
import { recentQuery, recentUrl } from './recent-query'

// Links are compared by what they resolve to, not by parameter order.
const parse = (url: string) => {
  const parsed = new URL(url, 'https://artifactshare.com')
  return {
    pathname: parsed.pathname,
    params: Object.fromEntries([...parsed.searchParams].sort()),
    hash: parsed.hash,
  }
}

describe('recentQuery', () => {
  test('normalizes invalid pages and ignores removed search parameters', () => {
    expect(
      recentQuery(new URLSearchParams('q=%20Notes%20&page=invalid')),
    ).toEqual({ relation: 'all', unread: false, page: 1 })
  })
})

test('normalizes IA filters and carries them through a link', () => {
  const filters = { relation: 'project', unread: true, page: 3 } as const
  expect(
    recentQuery(new URLSearchParams('relation=project&unread=1&page=3')),
  ).toEqual(filters)

  const link = recentUrl(filters)
  expect(parse(link)).toEqual({
    pathname: '/recent',
    params: { page: '3', relation: 'project', unread: '1' },
    hash: '',
  })
  expect(
    recentQuery(new URL(link, 'https://artifactshare.com').searchParams),
  ).toEqual(filters)
  expect(parse(recentUrl({ pathname: '/', ...filters, page: 1 }))).toEqual({
    pathname: '/',
    params: { relation: 'project', unread: '1' },
    hash: '',
  })
})

describe('recentUrl', () => {
  test('omits page one and preserves a supplied hash', () => {
    expect(recentUrl({ page: 1, hash: '#history' })).toBe('/recent#history')
  })
})
