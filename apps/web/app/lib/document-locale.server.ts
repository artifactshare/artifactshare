import type { Locale } from '~/i18n/messages'
import { isPublicPagePath, pathGuideLocale } from './guide-locale'
import { getLocale } from './i18n.server'
import { hasSafeArtifactInviteNext } from './safe-next'

export function documentLocale(
  request: Request,
  {
    url = new URL(request.url),
    user,
    linkDomain,
  }: {
    url?: URL
    user: { locale?: string | null } | null
    linkDomain: boolean
  },
): Locale {
  const pathname = url.pathname
  const hasSafeNext = hasSafeArtifactInviteNext(url.searchParams.get('next'))
  const forced =
    linkDomain || (pathname === '/' && (user || hasSafeNext))
      ? null
      : isPublicPagePath(pathname)
        ? pathGuideLocale(pathname)
        : null
  return forced ?? getLocale(request, user?.locale)
}
