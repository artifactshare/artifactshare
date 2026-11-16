import { describe, expect, test } from 'vitest'
import {
  reduceSearchKeywords,
  clearSearchFilters,
  parseSearchQuery,
  readSearchJson,
  searchConditionParts,
  searchConditionSummary,
  removeSelectedName,
  searchApiParams,
  searchHistoryParams,
} from './search-query'
import { canonicalSearch } from '~/services/search-input'
import {
  searchExitPath,
  searchNavigationState,
} from '~/lib/search-view-state'

test('screen scope round trips through API and history with explicit sort and UTC bounds', () => {
  const params = new URLSearchParams(
    'q=alpha&owner=a&owner=b&project=home&includeArchived=true&period=custom&dateField=viewed&from=2026-09-01&to=2026-09-02&sort=newest',
  )
  const input = parseSearchQuery(params)
  expect(input).toMatchObject({
    query: 'alpha',
    sort: 'newest',
    filters: {
      ownerUserIds: ['a', 'b'],
      location: { kind: 'home' },
      includeArchived: true,
      date: { field: 'viewed', to: new Date('2026-09-03T00:00:00Z') },
    },
  })
  if ('error' in input) throw new Error('healthy input rejected')
  expect(parseSearchQuery(searchHistoryParams(canonicalSearch(input)))).toEqual(
    input,
  )
  expect(clearSearchFilters(params).toString()).toBe('q=alpha&sort=newest')
  expect(searchApiParams(new URLSearchParams('owner=a')).get('sort')).toBe(
    'newest',
  )
  expect(
    searchApiParams(new URLSearchParams('owner=a&sort=relevance')).get('sort'),
  ).toBe('relevance')
})
test('invalid periods, duplicate scope and dates cannot broaden a search', () => {
  for (const query of [
    'period=1',
    'project=',
    'project=a&project=b',
    'period=custom&dateField=viewed&to=2026-02-30',
  ])
    expect(parseSearchQuery(new URLSearchParams(query))).toHaveProperty(
      'error.code',
      'validation_error',
    )
})
test('selecting a name removes only that span and preserves unrelated words', () => {
  expect(removeSelectedName('report Alex budget', 'Alex')).toBe('report budget')
  expect(removeSelectedName('report budget', 'Alex')).toBe('report budget')
  expect(removeSelectedName('annual report Ann', 'Ann')).toBe('annual report')
})

test('canonical history dates display inclusive calendar days without widening the interval', async () => {
  const { searchDateValue } = await import('./search-query')
  const original = parseSearchQuery(
    new URLSearchParams('period=custom&from=2026-09-01&to=2026-09-02'),
  )
  if ('error' in original) throw new Error('invalid control')
  const restored = searchHistoryParams(canonicalSearch(original))
  expect(searchDateValue(restored.get('from'))).toBe('2026-09-01')
  expect(searchDateValue(restored.get('to'), true)).toBe('2026-09-02')
  expect(searchDateValue('2026-09-02', true)).toBe('2026-09-02')
  expect(parseSearchQuery(restored)).toEqual(original)
})

test.each([
  ['Alpha Beta', 'Alpha'],
  ['  Ａlpha　東京の請求書　Beta  ', 'Ａlpha　東京の請求書'],
  ['東京の請求書', null],
  ['   ', null],
])(
  'reducing %s preserves user spelling and only removes a whitespace-delimited word',
  (input, expected) => {
    expect(reduceSearchKeywords(input)).toBe(expected)
  },
)

test('all time retains a valid date-field preference without applying an API date filter', () => {
  const params = new URLSearchParams('q=alpha&dateField=viewed')
  expect(searchApiParams(params).toString()).toBe('q=alpha')
  expect(parseSearchQuery(params)).toEqual(
    parseSearchQuery(new URLSearchParams('q=alpha')),
  )
  expect(params.get('dateField')).toBe('viewed')
  params.set('period', '7')
  expect(parseSearchQuery(params)).toMatchObject({
    filters: { date: { field: 'viewed' } },
  })
  for (const query of [
    'dateField=invalid',
    'dateField=',
    'dateField=viewed&dateField=updated',
    'period=custom&dateField=viewed',
  ])
    expect(parseSearchQuery(new URLSearchParams(query))).toHaveProperty(
      'error.code',
      'validation_error',
    )
})

describe('readSearchJson', () => {
  test('returns the body of a successful response', async () => {
    const response = new Response(JSON.stringify({ items: [] }), {
      status: 200,
    })
    await expect(readSearchJson<{ items: [] }>(response)).resolves.toEqual({
      items: [],
    })
    expect(response.bodyUsed).toBe(true)
  })
  test('reports the server error code and reads the body', async () => {
    const response = new Response(
      JSON.stringify({ error: { code: 'invalid_cursor', hint: '' } }),
      { status: 400 },
    )
    await expect(readSearchJson(response)).rejects.toThrow('invalid_cursor')
    expect(response.bodyUsed).toBe(true)
  })
  test('reports a validation error as itself, not as a cursor error', async () => {
    const response = new Response(
      JSON.stringify({ error: { code: 'invalid_date', hint: '' } }),
      { status: 400 },
    )
    await expect(readSearchJson(response)).rejects.toThrow('invalid_date')
  })
  test('falls back to request_failed without a JSON body', async () => {
    const response = new Response('oops', { status: 503 })
    await expect(readSearchJson(response)).rejects.toThrow('request_failed')
    expect(response.bodyUsed).toBe(true)
  })
})

describe('searchConditionParts', () => {
  const t = (key: string) => key
  const keys = (query: string, includeSort: boolean) =>
    searchConditionParts(
      new URLSearchParams(query),
      undefined,
      t as never,
      { includeSort },
    ).map((part) => part.label)
  test('names a non-default sort only when asked', () => {
    expect(keys('q=report&sort=newest', true)).toEqual(['search.newest'])
    expect(keys('q=report&sort=newest', false)).toEqual([])
    expect(keys('q=report&sort=relevance', true)).toEqual([])
  })
  test('treats newest as the default without keywords', () => {
    expect(keys('q=&sort=newest', true)).toEqual([])
    expect(keys('q=&sort=relevance', true)).toEqual(['search.relevance'])
  })
  test('keeps sort out of the filter summary used for zero results', () => {
    expect(
      searchConditionSummary(
        new URLSearchParams('q=report&sort=newest'),
        undefined,
        t as never,
      ),
    ).toBe('')
  })
})

describe('searchNavigationState', () => {
  test('remembers the page before search and keeps it across searches', () => {
    const first = searchNavigationState({ pathname: '/files', search: '?a=1' })
    expect(first.searchReturnTo).toBe('/files?a=1')
    const second = searchNavigationState({
      pathname: '/search',
      search: '?q=x',
      state: first,
    })
    expect(second.searchReturnTo).toBe('/files?a=1')
    expect(searchExitPath(second)).toBe('/files?a=1')
  })
  test('falls back to Home without a safe in-app path', () => {
    expect(searchExitPath(undefined)).toBe('/')
    expect(searchExitPath({ searchReturnTo: '//example.com' })).toBe('/')
  })
})
