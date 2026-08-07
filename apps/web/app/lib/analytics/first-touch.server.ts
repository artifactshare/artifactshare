import { readCookie, serializeCookie } from '~/lib/cookies.server'
import { FIRST_TOUCH_COOKIE, parseFirstTouch } from './first-touch'
import type { FirstTouch } from './first-touch'

export function readFirstTouch(request: Request): FirstTouch | null {
  return parseFirstTouch(readCookie(request, FIRST_TOUCH_COOKIE))
}
export function firstTouchClearCookieHeader(): string {
  return serializeCookie(FIRST_TOUCH_COOKIE, '', { maxAgeSeconds: 0 })
}
