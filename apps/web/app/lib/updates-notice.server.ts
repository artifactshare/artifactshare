import { env } from 'cloudflare:workers'
import { readCookie, serializeCookie } from './cookies.server'

const UPDATES_NOTICE_COOKIE = '__as_updates_notice'
export interface NoticeState {
  noticed?: string
  opened?: string
}
export function readUpdatesNotice(request: Request): NoticeState {
  const raw = readCookie(request, UPDATES_NOTICE_COOKIE)
  if (!raw) return {}
  try {
    const value = JSON.parse(raw) as NoticeState
    return {
      ...(typeof value.noticed === 'string' ? { noticed: value.noticed } : {}),
      ...(typeof value.opened === 'string' ? { opened: value.opened } : {}),
    }
  } catch {
    return {}
  }
}
export function updatesNoticeCookieHeader(state: NoticeState): string {
  return serializeCookie(UPDATES_NOTICE_COOKIE, JSON.stringify(state), {
    maxAgeSeconds: 31536000,
    httpOnly: true,
    secure: env.APP_ENV === 'production',
    sameSite: 'Lax',
  })
}
export function mergeUpdatesNotice(
  request: Request,
  slug: string,
  opened = false,
): string {
  const state = readUpdatesNotice(request)
  return updatesNoticeCookieHeader({
    noticed: slug,
    ...(opened || state.opened === slug ? { opened: slug } : {}),
  })
}
export function hasNoticed(state: NoticeState, slug: string): boolean {
  return state.noticed === slug
}
function hasOpened(state: NoticeState, slug: string): boolean {
  return state.opened === slug
}

export function updatesNoticePresentation(
  state: NoticeState,
  slug?: string,
): { slug?: string; dot: boolean; new: boolean } {
  return {
    ...(slug ? { slug } : {}),
    dot: !!slug && !hasNoticed(state, slug),
    new: !!slug && !hasOpened(state, slug),
  }
}
