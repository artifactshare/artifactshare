import pages from '~/public-pages.json'
import type { Locale } from '~/i18n/messages'

export interface PublicPagePaths {
  en: string
  ja: string
}

export type PublicPageMaster = Record<string, PublicPagePaths>

const ROOT_RELATIVE_PATH = /^\/(?!\/)/

export function validatePublicPageMaster(value: unknown): PublicPageMaster {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Public page master must be an object')
  }

  const master: PublicPageMaster = {}
  const pathsByLocale: Record<Locale, Set<string>> = {
    en: new Set(),
    ja: new Set(),
  }

  for (const [id, rawPaths] of Object.entries(value)) {
    if (!rawPaths || typeof rawPaths !== 'object' || Array.isArray(rawPaths)) {
      throw new Error(`Public page ${id} must define locale paths`)
    }
    const paths = rawPaths as Record<string, unknown>
    if (typeof paths.en !== 'string' || typeof paths.ja !== 'string') {
      throw new Error(`Public page ${id} must define en and ja paths`)
    }

    for (const locale of ['en', 'ja'] as const) {
      const path = paths[locale] as string
      if (!ROOT_RELATIVE_PATH.test(path)) {
        throw new Error(
          `Public page ${id} has a non-root-relative ${locale} path`,
        )
      }
      if (locale === 'en' && path.startsWith('/ja/')) {
        throw new Error(
          `Public page ${id} has a Japanese prefix on its en path`,
        )
      }
      if (locale === 'ja' && path !== '/ja' && !path.startsWith('/ja/')) {
        throw new Error(`Public page ${id} is missing the Japanese prefix`)
      }
      if (pathsByLocale[locale].has(path)) {
        throw new Error(`Duplicate ${locale} public page path: ${path}`)
      }
      pathsByLocale[locale].add(path)
    }

    master[id] = { en: paths.en, ja: paths.ja }
  }

  return master
}

const PUBLIC_PAGE_MASTER = validatePublicPageMaster(pages)

export function getPublicPagePath(
  id: string,
  locale: Locale,
): string | undefined {
  return PUBLIC_PAGE_MASTER[id]?.[locale]
}

export function getPublicPagePairs(): PublicPagePaths[] {
  return Object.values(PUBLIC_PAGE_MASTER)
}

export function isMasterPublicPagePath(pathname: string): boolean {
  return Object.values(PUBLIC_PAGE_MASTER).some(
    (paths) => paths.en === pathname || paths.ja === pathname,
  )
}

export function publicPagePathLocale(pathname: string): Locale | null {
  for (const paths of Object.values(PUBLIC_PAGE_MASTER)) {
    if (paths.en === pathname) return 'en'
    if (paths.ja === pathname) return 'ja'
  }
  return null
}
