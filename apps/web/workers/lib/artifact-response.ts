import type { ArtifactType } from '../../app/lib/artifact-type'
import {
  EXTERNAL_SCRIPT_CSP_SOURCES,
  STATIC_SITE_SCRIPT_DIRECTIVES,
} from './script-csp'

export const CSP_HEADER = 'Content-Security-Policy'
export const ROBOTS_HEADER = 'X-Robots-Tag'
export const ROBOTS_VALUE = 'noindex, nofollow'
export const REFERRER_POLICY = 'strict-origin'
const SOCIAL_EMBED_SCRIPT_CSP_SOURCES =
  'https://platform.twitter.com https://embed.bsky.app https://www.tiktok.com https://sf16-website-login.neutral.ttwstatic.com https://www.instagram.com https://www.threads.com https://www.threads.net'
const SOCIAL_EMBED_STYLE_CSP_SOURCES =
  'https://sf16-website-login.neutral.ttwstatic.com'
const SOCIAL_EMBED_CONNECT_CSP_SOURCES = 'https://www.tiktok.com'
const YOUTUBE_FRAME_CSP_SOURCES =
  'https://www.youtube-nocookie.com https://www.youtube.com'
const SOCIAL_EMBED_FRAME_CSP_SOURCES =
  'https://platform.twitter.com https://embed.bsky.app https://www.tiktok.com https://www.instagram.com https://www.threads.com https://www.threads.net'
const EMBED_FRAME_CSP_SOURCES = `${YOUTUBE_FRAME_CSP_SOURCES} ${SOCIAL_EMBED_FRAME_CSP_SOURCES}`
const EMBED_FULLSCREEN_PERMISSIONS_POLICY_SOURCES =
  EMBED_FRAME_CSP_SOURCES.split(' ')
    .map((source) => `"${source}"`)
    .join(' ')
export const PERMISSIONS_POLICY = `fullscreen=(self ${EMBED_FULLSCREEN_PERMISSIONS_POLICY_SOURCES}), clipboard-write=(self), camera=(), microphone=(), geolocation=(), display-capture=(), payment=(), usb=(), serial=(), hid=(), midi=()`
const MEDIA_CSP_SOURCES = "'self' https: data: blob:"

export function artifactContentSecurityPolicy(
  renderType: Exclude<ArtifactType, 'md'>,
  frameAncestors: string,
): string
export function artifactContentSecurityPolicy(
  renderType: ArtifactType,
  frameAncestors: string,
  reporterSha256: string,
): string
export function artifactContentSecurityPolicy(
  renderType: ArtifactType,
  frameAncestors: string,
  reporterSha256?: string,
): string {
  const directives =
    renderType === 'md'
      ? [
          "default-src 'none'",
          `script-src 'sha256-${reporterSha256}'`,
          "style-src 'unsafe-inline'",
          "img-src 'self' data: https:",
          "font-src 'self' data:",
          "connect-src 'none'",
          `frame-src ${YOUTUBE_FRAME_CSP_SOURCES}`,
        ]
      : renderType === 'html'
        ? [
            "default-src 'none'",
            `script-src 'unsafe-inline' 'unsafe-eval' ${EXTERNAL_SCRIPT_CSP_SOURCES} ${SOCIAL_EMBED_SCRIPT_CSP_SOURCES}`,
            `style-src 'unsafe-inline' https://cdn.jsdelivr.net https://cdnjs.cloudflare.com https://unpkg.com https://fonts.googleapis.com ${SOCIAL_EMBED_STYLE_CSP_SOURCES}`,
            "img-src 'self' data: https: blob:",
            "font-src 'self' data: https://fonts.gstatic.com https://cdn.jsdelivr.net",
            `media-src ${MEDIA_CSP_SOURCES}`,
            `connect-src ${EXTERNAL_SCRIPT_CSP_SOURCES} ${SOCIAL_EMBED_CONNECT_CSP_SOURCES}`,
            `frame-src ${EMBED_FRAME_CSP_SOURCES}`,
          ]
        : [
            "default-src 'none'",
            ...STATIC_SITE_SCRIPT_DIRECTIVES,
            `script-src-elem 'self' 'unsafe-inline' ${EXTERNAL_SCRIPT_CSP_SOURCES} ${SOCIAL_EMBED_SCRIPT_CSP_SOURCES}`,
            "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
            `style-src-elem 'self' 'unsafe-inline' https://fonts.googleapis.com ${SOCIAL_EMBED_STYLE_CSP_SOURCES}`,
            "img-src 'self' data: blob:",
            "font-src 'self' data: https://fonts.gstatic.com",
            `media-src ${MEDIA_CSP_SOURCES}`,
            `connect-src 'self' ${EXTERNAL_SCRIPT_CSP_SOURCES} ${SOCIAL_EMBED_CONNECT_CSP_SOURCES} https://extensions.duckdb.org`,
            `frame-src ${EMBED_FRAME_CSP_SOURCES}`,
          ]
  return [
    ...directives,
    `frame-ancestors ${frameAncestors}`,
    "base-uri 'none'",
    "form-action 'none'",
    'sandbox allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox allow-downloads',
  ].join('; ')
}

export function contentResponse(
  body: string | ReadableStream<Uint8Array> | null,
  contentType: string,
  csp: string | null,
  init?: { status?: number; headers?: Headers },
  responseDomain?: { domain: string },
): Response {
  const headers = new Headers({
    'Content-Type': contentType,
    'Cache-Control': 'private, no-store, no-transform',
    'Cross-Origin-Resource-Policy':
      responseDomain?.domain === 'link' ? 'cross-origin' : 'same-site',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Permissions-Policy': PERMISSIONS_POLICY,
    'Referrer-Policy': REFERRER_POLICY,
    [ROBOTS_HEADER]: ROBOTS_VALUE,
    'X-Content-Type-Options': 'nosniff',
  })
  for (const [name, value] of init?.headers ?? []) headers.set(name, value)
  const response = new Response(body, {
    status: init?.status,
    headers,
  })
  if (csp) response.headers.set(CSP_HEADER, csp)
  return response
}

// Workers loaded from URLs use the script response policy, unlike blob workers.
function isJavaScriptContent(contentType: string): boolean {
  const essence = contentType.split(';', 1)[0].trim().toLowerCase()
  return (
    /^(?:application|text)\/(?:x-)?(?:javascript|ecmascript)$/.test(essence) ||
    /^text\/(?:javascript1\.[0-5]|jscript|livescript)$/.test(essence)
  )
}

// Service workers can synthesize responses without the artifact policy.
export function staticSiteServiceWorkerRefusal(
  request: Request,
  responseDomain?: { domain: string },
): Response | null {
  if (request.headers.get('Service-Worker')?.trim().toLowerCase() !== 'script')
    return null
  return contentResponse(
    null,
    'text/plain; charset=utf-8',
    null,
    { status: 403 },
    responseDomain,
  )
}

function isXmlContent(contentType: string): boolean {
  const essence = contentType.split(';', 1)[0].trim().toLowerCase()
  return (
    essence === 'application/xml' ||
    essence === 'text/xml' ||
    essence.endsWith('+xml')
  )
}

export function staticSiteAssetResponse(
  body: string | ReadableStream<Uint8Array> | null,
  contentType: string,
  frameAncestors: string,
  init?: { status?: number; headers?: Headers },
  responseDomain?: { domain: string },
): Response {
  return contentResponse(
    body,
    contentType,
    isJavaScriptContent(contentType) || isXmlContent(contentType)
      ? artifactContentSecurityPolicy('static_site', frameAncestors)
      : null,
    init,
    responseDomain,
  )
}
