import {
  FIRST_TOUCH_COOKIE,
  FIRST_TOUCH_MAX_AGE_SECONDS,
  referrerDomainFromReferrer,
  serializeFirstTouch,
  utmFromSearch,
} from './first-touch'

export function captureFirstTouch(input: {
  shouldLoadAnalytics: boolean
  artifactId?: string
}): void {
  if (!input.shouldLoadAnalytics || typeof document === 'undefined') return
  if (
    document.cookie
      .split(';')
      .some((part) => part.trim().startsWith(`${FIRST_TOUCH_COOKIE}=`))
  )
    return
  const referrerDomain = referrerDomainFromReferrer(document.referrer)
  const ft = {
    utm: utmFromSearch(location.search),
    // Same-host navigation says nothing about where the visitor came from.
    referrerDomain:
      referrerDomain === location.host ? undefined : referrerDomain,
    artifactId: input.artifactId,
  }
  if (!ft.utm && !ft.referrerDomain && !ft.artifactId) return
  const secure = location.protocol === 'https:' ? '; Secure' : ''
  document.cookie = `${FIRST_TOUCH_COOKIE}=${encodeURIComponent(serializeFirstTouch(ft))}; Path=/; Max-Age=${FIRST_TOUCH_MAX_AGE_SECONDS}; SameSite=Lax${secure}`
}

export function clearFirstTouch(): void {
  document.cookie = `${FIRST_TOUCH_COOKIE}=; Path=/; Max-Age=0; SameSite=Lax`
}
