import { describe, expect, test } from 'vitest'
import { bindI18n, t, tPlural } from './i18n'

describe('t', () => {
  test('translates a known key', () => {
    expect(t('en', 'vw.back')).toBe('Back')
    expect(t('ja', 'vw.back')).toBe('戻る')
  })

  test('interpolates {var} placeholders', () => {
    expect(t('en', 'toast.copied', { url: 'https://x' })).toBe(
      'Copied · https://x',
    )
  })

  test('interpolates multiple vars + numbers', () => {
    expect(t('en', 'tb.fileCountOther', { n: 5 })).toBe('5 files')
  })

  test('falls back to English for missing JA key', () => {
    // Both catalogs share the same key surface (TKey union), so a true
    // "missing in JA, present in EN" scenario requires casting. We instead
    // verify the fallback path returns the EN string when an unknown locale
    // is passed.
    // @ts-expect-error — runtime fallback for unrecognized locale
    expect(t('fr', 'vw.back')).toBe('Back')
  })

  test('returns key string when key not found in any locale', () => {
    // @ts-expect-error — bypass TKey for fallback-path test
    expect(t('en', 'nonexistent.key')).toBe('nonexistent.key')
  })

  test('omits missing var (no throw)', () => {
    expect(t('en', 'toast.copied')).toBe('Copied · ')
  })
})

describe('tPlural', () => {
  test('picks One form when n === 1', () => {
    expect(tPlural('en', 'tb.fileCount', 1)).toBe('1 file')
    expect(tPlural('ja', 'tb.fileCount', 1)).toBe('ファイル 1 件')
  })

  test('picks Other form when n !== 1', () => {
    expect(tPlural('en', 'tb.fileCount', 0)).toBe('0 files')
    expect(tPlural('en', 'tb.fileCount', 2)).toBe('2 files')
    expect(tPlural('en', 'tb.fileCount', 42)).toBe('42 files')
  })

  test('Recent tab uses a distinct count label', () => {
    expect(tPlural('ja', 'tb.recentCount', 1)).toBe('最近見たもの 1 件')
    expect(tPlural('ja', 'tb.recentCount', 5)).toBe('最近見たもの 5 件')
    expect(tPlural('en', 'tb.recentCount', 1)).toBe('1 recently seen')
    expect(tPlural('en', 'tb.recentCount', 5)).toBe('5 recently seen')
  })

  test('injects n as a var automatically', () => {
    expect(tPlural('en', 'card.viewCount', 7)).toBe('7 views')
    expect(tPlural('ja', 'card.viewCount', 7)).toBe('閲覧 7 回')
  })
})

describe('bindI18n', () => {
  test('curries locale into t / tPlural', () => {
    const j = bindI18n('ja')
    expect(j.locale).toBe('ja')
    expect(j.t('vw.back')).toBe('戻る')
    expect(j.tPlural('tb.fileCount', 3)).toBe('ファイル 3 件')
  })
})
