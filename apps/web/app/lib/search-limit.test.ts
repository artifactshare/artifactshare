import { expect, test } from 'vitest'
import { searchResetTime, SearchRequestError } from './search-limit'
import { readSearchJson } from './search-query'
import en from '~/i18n/en.json'
import ja from '~/i18n/ja.json'

test('reset formatting uses a deterministic explicit UTC zone in both locales', () => {
  const at = '2026-11-21T00:00:00.000Z'
  expect(searchResetTime(at, 'en')).toBe('Nov 21, 2026, 00:00 UTC')
  expect(searchResetTime(at, 'ja')).toBe('2026年11月21日 00:00 UTC')
  for (const messages of [en, ja])
    expect(messages['search.dailyLimit'].match(/\{[^}]+\}/g)).toEqual([
      '{time}',
    ])
})

test('search response parsing preserves daily reset metadata but keeps existing error codes', async () => {
  const error = {
    code: 'search_daily_limit_exceeded',
    retry_at: '2026-11-21T00:00:00.000Z',
  }
  await expect(
    readSearchJson(Response.json({ error }, { status: 429 })),
  ).rejects.toMatchObject({ message: error.code, retryAt: error.retry_at })
  expect(new SearchRequestError({ code: 'invalid_cursor' }).message).toBe(
    'invalid_cursor',
  )
})
