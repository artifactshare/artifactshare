import { expect, test } from 'vitest'
import en from './en.json'
import ja from './ja.json'

// `messages.ts` derives TKey from en.json and casts ja to it, so a key that
// only one catalog has is not a type error, and `t` silently falls back to
// English. `tPlural` goes further and builds keys by concatenation
// (`stem + 'One' | 'Other'`), which escapes TKey entirely. Every key of both
// catalogs is compared here so neither gap needs a per-key test elsewhere.

type Catalog = Record<string, string>

const catalogs: Record<'en' | 'ja', Catalog> = { en, ja: ja as Catalog }
const keys = (locale: 'en' | 'ja') => Object.keys(catalogs[locale])

const placeholders = (value: string) =>
  [...new Set(value.match(/\{\w+\}/g) ?? [])].sort()

test('both catalogs translate the same keys', () => {
  expect({
    missingInJa: keys('en').filter((key) => !(key in catalogs.ja)),
    missingInEn: keys('ja').filter((key) => !(key in catalogs.en)),
  }).toEqual({ missingInJa: [], missingInEn: [] })
})

test('a key interpolates the same placeholders in both catalogs', () => {
  // A placeholder nobody passes renders as an empty string. A value a caller
  // passes but a catalog never names is worse: that locale's reader loses it,
  // so a count shows in one language and not in the other.
  const mismatched = keys('en')
    .filter((key) => key in catalogs.ja)
    .map((key) => ({
      key,
      en: placeholders(catalogs.en[key]),
      ja: placeholders(catalogs.ja[key]),
    }))
    .filter(({ en: inEn, ja: inJa }) => String(inEn) !== String(inJa))

  expect(mismatched).toEqual([])
})

test('Japanese copy is present wherever English has copy', () => {
  // The reverse is allowed: Japanese adds suffixes English does not need
  // (`lp.uc.*.statPost`), and a few keys are blank in both on purpose.
  const blankInJa = keys('en').filter(
    (key) =>
      catalogs.en[key].trim() !== '' && (catalogs.ja[key] ?? '').trim() === '',
  )
  expect(blankInJa).toEqual([])
})
