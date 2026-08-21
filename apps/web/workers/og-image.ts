import { DEFAULT_LOCALE, isSupportedLocale } from '../app/i18n/messages'
import {
  renderConnectOgImage,
  renderHomeOgImage,
  renderShareOgImage,
  renderPrivateMobileDesignHandoffOgImage,
  renderUpdatesEntryOgImage,
} from '../app/services/preview-image.server'

type OgImageEnv = {
  SLACK_PREVIEW_FONT_KV: KVNamespace
  APP_ENV: string
  DEFAULT_LOCALE: 'en'
}

const DEFAULT_CACHE_CONTROL = 'public, max-age=86400, s-maxage=604800'

export default {
  async fetch(request, env) {
    const url = new URL(request.url)

    if (url.pathname === '/home') {
      const requestedLocale = url.searchParams.get('lang')
      const locale = isSupportedLocale(requestedLocale)
        ? requestedLocale
        : DEFAULT_LOCALE
      const png = await renderHomeOgImage(locale, env.SLACK_PREVIEW_FONT_KV)
      return pngResponse(png)
    }

    if (url.pathname === '/connect') {
      const requestedLocale = url.searchParams.get('lang')
      const locale = isSupportedLocale(requestedLocale)
        ? requestedLocale
        : DEFAULT_LOCALE
      const png = await renderConnectOgImage(locale, env.SLACK_PREVIEW_FONT_KV)
      return pngResponse(png)
    }

    if (url.pathname === '/share') {
      const title = url.searchParams.get('title')
      const urlLabel = url.searchParams.get('url')
      if (!title || !urlLabel) {
        return new Response('bad request\n', { status: 400 })
      }
      const png = await renderShareOgImage({
        title,
        ownerLabel: url.searchParams.get('owner'),
        urlLabel,
        fontKv: env.SLACK_PREVIEW_FONT_KV,
      })
      return pngResponse(png)
    }

    if (url.pathname === '/updates-entry') {
      const title = url.searchParams.get('title')
      const urlLabel = url.searchParams.get('url')
      if (!title || !urlLabel) {
        return new Response('bad request\n', { status: 400 })
      }
      const requestedLocale = url.searchParams.get('lang')
      const locale = isSupportedLocale(requestedLocale)
        ? requestedLocale
        : DEFAULT_LOCALE
      const png = await renderUpdatesEntryOgImage({
        title,
        locale,
        urlLabel,
        fontKv: env.SLACK_PREVIEW_FONT_KV,
      })
      return pngResponse(png)
    }

    if (url.pathname === '/private-mobile-design-handoff') {
      const requestedLocale = url.searchParams.get('lang')
      const locale = isSupportedLocale(requestedLocale)
        ? requestedLocale
        : DEFAULT_LOCALE
      const png = await renderPrivateMobileDesignHandoffOgImage(
        locale,
        env.SLACK_PREVIEW_FONT_KV,
      )
      return pngResponse(png)
    }

    return new Response('not found\n', { status: 404 })
  },
} satisfies ExportedHandler<OgImageEnv>

function pngResponse(png: Uint8Array): Response {
  return new Response(png as BodyInit, {
    headers: {
      'content-type': 'image/png',
      'cache-control': DEFAULT_CACHE_CONTROL,
    },
  })
}
