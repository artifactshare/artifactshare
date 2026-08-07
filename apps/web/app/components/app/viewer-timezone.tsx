import { useEffect } from 'react'
import { useRevalidator } from 'react-router'
import {
  getBrowserTimeZone,
  timezoneSyncAction,
} from '~/lib/viewer-timezone.client'

const TZ_COOKIE = '__as_tz'

function readTzCookieValue(): string | null {
  const prefix = `${TZ_COOKIE}=`
  for (const part of document.cookie.split(';')) {
    const trimmed = part.trim()
    if (trimmed.startsWith(prefix)) {
      try {
        return decodeURIComponent(trimmed.slice(prefix.length))
      } catch {
        return null
      }
    }
  }
  return null
}

function writeTzCookie(timeZone: string): void {
  document.cookie = `${TZ_COOKIE}=${encodeURIComponent(timeZone)}; Path=/; Max-Age=31536000; SameSite=Lax`
}

export function ViewerTimezone(): null {
  const { revalidate } = useRevalidator()

  useEffect(() => {
    const desired = getBrowserTimeZone()
    const current = readTzCookieValue()
    const action = timezoneSyncAction(current, desired)
    if (!action.writeCookie) return

    writeTzCookie(desired)
    if (action.revalidate) {
      revalidate()
    }
  }, [revalidate])

  return null
}
