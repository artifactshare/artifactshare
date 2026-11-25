import { describe, expect, test } from 'vitest'
import { MESSAGES } from '~/i18n/messages'
import { bindI18n, t, tPlural } from './i18n'

// Catalog contents (every key present in both locales, matching
// placeholders) are checked in `app/i18n/catalog-parity.test.ts`. Here: the
// lookup, fallback and interpolation rules a caller depends on.

describe('t', () => {
  test('reads the asked-for locale, not the default one', () => {
    expect(t('ja', 'vw.back')).toBe(MESSAGES.ja['vw.back'])
    expect(t('en', 'vw.back')).toBe(MESSAGES.en['vw.back'])
    expect(t('ja', 'vw.back')).not.toBe(t('en', 'vw.back'))
  })

  test('interpolates {var} placeholders', () => {
    const copied = t('en', 'toast.copied', { url: 'https://x' })
    expect(copied).toContain('https://x')
    expect(copied).not.toMatch(/\{\w+\}/)
  })

  test('interpolates numbers', () => {
    expect(t('en', 'tb.fileCountOther', { n: 5 })).toContain('5')
  })

  test('replaces a placeholder that repeats in one message', () => {
    const notice = t('ja', 'toast.projectHasAgentCredentials', {
      holder: 'Dana',
    })
    expect(MESSAGES.ja['toast.projectHasAgentCredentials']).toContain(
      '{holder}',
    )
    expect(notice).toContain('Dana')
    expect(notice).not.toMatch(/\{\w+\}/)
  })

  test('falls back to English for an unrecognized locale', () => {
    // @ts-expect-error — runtime fallback for unrecognized locale
    expect(t('fr', 'vw.back')).toBe(MESSAGES.en['vw.back'])
  })

  test('returns key string when key not found in any locale', () => {
    // @ts-expect-error — bypass TKey for fallback-path test
    expect(t('en', 'nonexistent.key')).toBe('nonexistent.key')
  })

  test('drops a var the caller did not pass instead of showing its name', () => {
    const copied = t('en', 'toast.copied')
    expect(copied).not.toContain('{url}')
    expect(copied).not.toContain('url')
  })
})

describe('tPlural', () => {
  test.each([0, 1, 2, 42])('shows the count for n=%i', (n) => {
    for (const locale of ['en', 'ja'] as const)
      for (const stem of [
        'tb.fileCount',
        'project.fileCount',
        'card.viewCount',
      ])
        expect(tPlural(locale, stem, n)).toContain(String(n))
  })

  test('picks the One form at 1 and the Other form otherwise', () => {
    for (const locale of ['en', 'ja'] as const) {
      expect(tPlural(locale, 'tb.fileCount', 1)).toBe(
        t(locale, 'tb.fileCountOne', { n: 1 }),
      )
      for (const n of [0, 2, 42])
        expect(tPlural(locale, 'tb.fileCount', n)).toBe(
          t(locale, 'tb.fileCountOther', { n }),
        )
    }
  })

  test('keeps counted labels apart from one another', () => {
    expect(tPlural('en', 'tb.recentCount', 5)).not.toBe(
      tPlural('en', 'tb.fileCount', 5),
    )
    expect(tPlural('ja', 'tb.recentCount', 5)).not.toBe(
      tPlural('ja', 'tb.fileCount', 5),
    )
  })

  test('passes extra vars through alongside the injected n', () => {
    const confirmation = tPlural('en', 'externalAccess.expiry.confirmBody', 3, {
      days: 7,
    })
    expect(confirmation).toContain('3')
    expect(confirmation).toContain('7')
    expect(confirmation).not.toMatch(/\{\w+\}/)
  })
})

describe('bindI18n', () => {
  test('curries locale into t / tPlural', () => {
    const j = bindI18n('ja')
    expect(j.locale).toBe('ja')
    expect(j.t('vw.back')).toBe(t('ja', 'vw.back'))
    expect(j.tPlural('tb.fileCount', 3)).toBe(tPlural('ja', 'tb.fileCount', 3))
  })
})
