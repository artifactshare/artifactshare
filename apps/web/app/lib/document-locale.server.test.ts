import { expect, test } from 'vitest'
import { documentLocale } from './document-locale.server'

const english = { locale: 'en' }

test('a Japanese public page keeps Japanese for an English user', () => {
  const request = new Request('https://app.example/ja/pricing')
  expect(documentLocale(request, { user: english, linkDomain: false })).toBe(
    'ja',
  )
})

test('an app page and a link host follow the user language', () => {
  expect(
    documentLocale(new Request('https://app.example/settings/general'), {
      user: english,
      linkDomain: false,
    }),
  ).toBe('en')
  expect(
    documentLocale(new Request('https://link.example/ja/pricing'), {
      user: english,
      linkDomain: true,
    }),
  ).toBe('en')
})
