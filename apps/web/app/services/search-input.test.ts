import { expect, test } from 'vitest'
import { parseSearchInput } from './search-input'
import {
  prepareQuery,
  bindAllowedIds,
  ALLOWED_ID_BINDING_BYTES,
  SearchCapacityError,
} from './search-index/query'

test('strict dates reject impossible or unzoned values and use exclusive date-only ends', () => {
  for (const value of [
    '2026-02-30',
    '2026-03-01T12:00:00',
    '2026-03-01T24:00:00Z',
  ])
    expect(
      parseSearchInput(
        new URLSearchParams({ dateField: 'updated', from: value }),
      ),
    ).toHaveProperty('error')
  const parsed = parseSearchInput(
    new URLSearchParams({
      dateField: 'viewed',
      from: '2026-02-28',
      to: '2026-02-28',
    }),
  )
  expect(parsed).toMatchObject({
    filters: {
      date: {
        from: new Date('2026-02-28T00:00:00Z'),
        to: new Date('2026-03-01T00:00:00Z'),
      },
    },
  })
})
test('query syntax is quoted and Katakana preserves segmented and prefix alternatives', () => {
  expect(prepareQuery('a* NEAR(a b) title:x OR NOT').expressions).toEqual([
    '{title body script}: "a"',
    '{title body script}: "near"',
    '{title body script}: "a"',
    '{title body script}: "b"',
    '{title body script}: "title:x"',
    '{title body script}: "or"',
    '{title body script}: "not"',
  ])
  expect(prepareQuery('"').terms).toEqual([])
  expect(prepareQuery('プログラミング').runExpressions).toEqual([
    '"プログラミング"*',
  ])
  expect(prepareQuery('カー').expressions[0]).toContain('"カー"*')
  expect(prepareQuery('プログラミング').expressions[0]).toContain(
    ' OR {title body script}: "プログラミング"*',
  )
})

test('excerpts center on matching text rather than truncating the beginning', async () => {
  const { excerpt } = await import('./search-index/query')
  const body = `${'before '.repeat(100)}needle ${'after '.repeat(100)}`
  const result = excerpt(body, 'needle')
  expect(result).toContain('needle')
  expect(result.startsWith('…')).toBe(true)
  expect(result.length).toBeLessThanOrEqual(242)
  expect(excerpt(body, 'absent')).toBe('')
})

test('excerpts preserve original spans through NFKC expansion and Katakana segmentation', async () => {
  const { excerpt } = await import('./search-index/query')
  for (const length of [100, 400])
    expect(excerpt('ﬃ'.repeat(length) + 'needle', 'needle')).toContain('needle')
  expect(
    excerpt('フロントエンドエンジニアの募集', 'フロントエンドエンジニア'),
  ).toContain('フロントエンドエンジニア')
  expect(
    excerpt('フロントエンドエンジニアの募集', 'フロントエンドエンジ'),
  ).toContain('フロントエンドエンジニア')
  expect(
    excerpt('フロント エンド エンジニアの募集', 'フロントエンドエンジニア'),
  ).toContain('フロント エンド エンジニア')
})

test('Home rejects any projectId parameter', () => {
  expect(parseSearchInput(new URLSearchParams('location=home'))).toMatchObject({
    filters: { location: { kind: 'home' } },
  })
  for (const projectId of ['', 'project'])
    expect(
      parseSearchInput(new URLSearchParams({ location: 'home', projectId })),
    ).toHaveProperty('error.code', 'validation_error')
})

test('allowed-ID bindings preserve large sets and multibyte IDs within each byte budget', () => {
  const id = '界'.repeat(200_000)
  const ids = [id, id + 'x']
  const bindings = bindAllowedIds(ids)
  expect(bindings.flatMap((value) => JSON.parse(value))).toEqual(ids)
  expect(bindings).toHaveLength(2)
  for (const value of bindings)
    expect(new TextEncoder().encode(value).byteLength).toBeLessThanOrEqual(
      ALLOWED_ID_BINDING_BYTES,
    )
  expect(bindAllowedIds(Array.from({ length: 11 }, () => id))).toHaveLength(11)
  const many = Array.from({ length: 130_000 }, (_, i) => String(i))
  expect(bindAllowedIds(many).flatMap((value) => JSON.parse(value))).toEqual(
    many,
  )
  expect(() => bindAllowedIds(['x'.repeat(ALLOWED_ID_BINDING_BYTES)])).toThrow(
    SearchCapacityError,
  )
})

test('highlight spans preserve Japanese segmented, prefix and normalized source matches', async () => {
  const { searchMatchSpans } = await import('./search-index/query')
  for (const [body, query, expected] of [
    ['ordinary alpha text', 'alpha', 'alpha'],
    [
      'フロント エンド エンジニアの募集',
      'フロントエンドエンジニア',
      'フロント エンド エンジニア',
    ],
    ['エンジニアの募集', 'エンジ', 'エンジ'],
    ['ｺﾝﾋﾟｭｰﾀの募集', 'コンピューター', 'ｺﾝﾋﾟｭｰﾀ'],
  ]) {
    expect(
      searchMatchSpans(body, query).map(([a, b]) => body.slice(a, b)),
    ).toContain(expected)
    expect(searchMatchSpans(body, 'unmatched')).toEqual([])
  }
})
