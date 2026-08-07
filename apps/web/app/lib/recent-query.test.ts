import { describe, expect, test } from 'vitest'
import { recentQuery, recentUrl } from './recent-query'

describe('recentQuery', () => {
  test('normalizes invalid pages and ignores removed search parameters', () => {
    expect(
      recentQuery(new URLSearchParams('q=%20Notes%20&page=invalid')),
    ).toEqual({ relation: 'all', unread: false, page: 1 })
  })
})

test('normalizes IA filters and preserves them in links', () => {
  expect(
    recentQuery(new URLSearchParams('relation=project&unread=1&page=3')),
  ).toEqual({
    relation: 'project',
    unread: true,
    page: 3,
  })
  expect(recentUrl({ page: 3, relation: 'project', unread: true })).toBe(
    '/recent?page=3&relation=project&unread=1',
  )
  expect(recentUrl({ pathname: '/', relation: 'project', unread: true })).toBe(
    '/?relation=project&unread=1',
  )
})

describe('recentUrl', () => {
  test('omits page one and preserves a supplied hash', () => {
    expect(recentUrl({ page: 1, hash: '#history' })).toBe('/recent#history')
  })
})
