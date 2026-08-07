import { env } from 'cloudflare:workers'

import type { Locale } from '~/i18n/messages'

const OG_WORKER_ORIGIN = 'https://og-image.artifactshare.internal'

export function fetchHomeOgImage(): Promise<Response> {
  return env.OG_IMAGE_WORKER.fetch(new URL('/home', OG_WORKER_ORIGIN))
}

export function fetchConnectOgImage(locale: Locale): Promise<Response> {
  const url = new URL('/connect', OG_WORKER_ORIGIN)
  url.searchParams.set('lang', locale)
  return env.OG_IMAGE_WORKER.fetch(url)
}

export function fetchShareOgImage(input: {
  title: string
  ownerLabel: string | null
  urlLabel: string
}): Promise<Response> {
  const url = new URL('/share', OG_WORKER_ORIGIN)
  url.searchParams.set('title', input.title)
  url.searchParams.set('url', input.urlLabel)
  if (input.ownerLabel) url.searchParams.set('owner', input.ownerLabel)
  return env.OG_IMAGE_WORKER.fetch(url)
}

export function fetchUpdatesEntryOgImage(
  title: string,
  locale: Locale,
  slug: string,
): Promise<Response> {
  const path = locale === 'ja' ? `/ja/updates/${slug}` : `/updates/${slug}`
  const url = new URL('/updates-entry', OG_WORKER_ORIGIN)
  url.searchParams.set('title', title)
  url.searchParams.set('lang', locale)
  url.searchParams.set('url', `artifactshare.com${path}`)
  return env.OG_IMAGE_WORKER.fetch(url)
}

export function fetchPrivateMobileDesignHandoffOgImage(
  locale: Locale,
): Promise<Response> {
  const url = new URL('/private-mobile-design-handoff', OG_WORKER_ORIGIN)
  url.searchParams.set('lang', locale)
  return env.OG_IMAGE_WORKER.fetch(url)
}
