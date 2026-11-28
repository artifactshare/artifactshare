// Relative, not aliased: the browser drivers read the catalogue from the
// Vitest config graph, which is bundled before the `~` alias exists.
import {
  DEFAULT_LOCALE,
  MESSAGES,
  type Locale,
  type TKey,
} from '../i18n/messages'

export type { Locale, TKey }

type Vars = Record<string, string | number>

export function t(locale: Locale, key: TKey, vars?: Vars): string {
  const dict = MESSAGES[locale] ?? MESSAGES[DEFAULT_LOCALE]
  const raw = dict[key] ?? MESSAGES[DEFAULT_LOCALE][key] ?? key
  return raw.replace(/\{(\w+)\}/g, (_, name: string) => {
    const v = vars?.[name]
    return v === undefined ? '' : String(v)
  })
}

export function tPlural(
  locale: Locale,
  stem: string,
  n: number,
  vars?: Vars,
): string {
  const suffix = n === 1 ? 'One' : 'Other'
  const key = (stem + suffix) as TKey
  return t(locale, key, { ...vars, n })
}

export function bindI18n(locale: Locale) {
  return {
    locale,
    t: (key: TKey, vars?: Vars) => t(locale, key, vars),
    tPlural: (stem: string, n: number, vars?: Vars) =>
      tPlural(locale, stem, n, vars),
  }
}

export type Translator = ReturnType<typeof bindI18n>
