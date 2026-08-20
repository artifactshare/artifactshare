import { env } from 'cloudflare:workers'
import type { Kysely } from 'kysely'
import type { ArtifactType } from '../app/lib/artifact-type'
import { decodeBase64Url, encodeBase64Url } from '../app/lib/base64url'
import {
  APEX_HOST,
  APP_DEV_PORT,
  isProduction,
  MCP_EMBED_FRAME_ANCESTORS,
  requestHostname,
  sandboxVersionIdentityFromHostname,
  SANDBOX_HOST,
  WWW_HOST,
} from '../app/lib/hosts'
import {
  type SandboxPayload,
  verifySandboxTokenDetailed,
} from '../app/lib/sandbox-token'
import { type ArtifactKind } from '../app/lib/shareable-types'
import { renderMarkdownDocument } from '../app/lib/markdown-render'
import { createDb } from '../app/services/db.server'
import { consumeJti } from '../app/services/sandbox-jti.server'
import { getArtifact } from '../app/services/storage.server'
import { viewerDisplayCheck } from '../app/services/access.server'
import type { ArtifactSnapshot } from '../app/services/access.server'
import type { DB } from '../app/types/db'
import {
  VIOLATION_REPORTER_SHA256,
  VIOLATION_REPORTER_TAG,
} from '../app/lib/csp-reporter'
import { validateBundlePath } from './lib/path-validator'
import {
  SANDBOX_PROBE_MARKER,
  SANDBOX_PROBE_PATH,
} from '../app/lib/sandbox-block-report'

const COOKIE_NAME = 'as_bnd'
const COOKIE_TTL_SECONDS = 10 * 60
const CSP_HEADER = 'Content-Security-Policy'
const ROBOTS_HEADER = 'X-Robots-Tag'
const ROBOTS_VALUE = 'noindex, nofollow'
const PERMISSIONS_POLICY =
  'fullscreen=(self "https://www.youtube-nocookie.com" "https://www.youtube.com"), clipboard-write=(self), camera=(), microphone=(), geolocation=(), display-capture=(), payment=(), usb=(), serial=(), hid=(), midi=()'
const REFERRER_POLICY = 'strict-origin'
const EXTERNAL_SCRIPT_CSP_SOURCES =
  'https://cdn.jsdelivr.net https://cdnjs.cloudflare.com https://unpkg.com https://esm.sh https://cdn.tailwindcss.com'
const YOUTUBE_FRAME_CSP_SOURCES =
  'https://www.youtube-nocookie.com https://www.youtube.com'
const ENCODER = new TextEncoder()
const DECODER = new TextDecoder()

interface BundleCookiePayload {
  wid: string
  aid: string
  vid: string
  exp: number
}

export async function handleArtifactSandboxRequest(
  request: Request,
  _ctx?: ExecutionContext,
): Promise<Response> {
  const url = new URL(request.url)
  const hostname = requestHostname(request, env)
  const identity = sandboxVersionIdentityFromHostname(hostname, env)
  if (url.pathname === SANDBOX_PROBE_PATH) return sandboxProbeResponse(request)
  if (!identity) {
    return deniedResponse('bad_hostname', 'Not found', 404, { hostname })
  }

  const path = requestPath(url)
  if (!path) {
    return deniedResponse('bad_path', 'Not found', 404, {
      aid: identity?.shareableId,
      pathname: url.pathname,
    })
  }

  const token = url.searchParams.get('t')
  if (token) {
    return await handleEntrypointRequest(request, url, identity, path, token)
  }

  const cookie = await verifyBundleCookie(
    cookieValue(request.headers.get('Cookie'), COOKIE_NAME),
    env.BETTER_AUTH_SECRET,
  )
  if (!cookie) {
    if (identity !== null) {
      return await serveAnonymousLinkBundleAsset(identity, path)
    }
    return deniedResponse('no_bundle_cookie', 'Invalid token', 401, { path })
  }
  if (
    identity !== null &&
    (cookie.aid !== identity.shareableId || cookie.vid !== identity.versionId)
  ) {
    return deniedResponse('cookie_identity_mismatch', 'Invalid token', 401, {
      aid: identity.shareableId,
      vid: identity.versionId,
      cookieAid: cookie.aid,
      path,
    })
  }
  return await serveBundleAsset(cookie, path)
}

function sandboxProbeResponse(request: Request): Response {
  const origin = request.headers.get('Origin')
  const allowed = new Set([
    `https://${APEX_HOST}`,
    `https://${WWW_HOST}`,
    `https://localhost:${APP_DEV_PORT}`,
  ])
  const headers = new Headers({
    'Cache-Control': 'private, no-store, no-transform',
    'Content-Type': 'text/plain; charset=utf-8',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Resource-Policy': 'same-site',
    'Permissions-Policy': PERMISSIONS_POLICY,
    'Referrer-Policy': REFERRER_POLICY,
    [ROBOTS_HEADER]: ROBOTS_VALUE,
    'X-Content-Type-Options': 'nosniff',
    'X-ArtifactShare-Sandbox-Probe': SANDBOX_PROBE_MARKER,
  })
  if (origin && allowed.has(origin)) {
    headers.set('Access-Control-Allow-Origin', origin)
    headers.set(
      'Access-Control-Expose-Headers',
      'X-ArtifactShare-Sandbox-Probe',
    )
    headers.set('Vary', 'Origin')
  }
  return new Response(SANDBOX_PROBE_MARKER, { status: 200, headers })
}

export function sandboxNotFoundResponse(hostname: string): Response {
  return deniedResponse('unmatched_hostname', 'Not found', 404, { hostname })
}

async function handleEntrypointRequest(
  request: Request,
  url: URL,
  identity: { shareableId: string; versionId: string },
  path: string,
  token: string,
): Promise<Response> {
  const verified = await verifySandboxTokenDetailed(
    token,
    env.BETTER_AUTH_SECRET,
  )
  if (!verified.ok) {
    return deniedResponse(`token_${verified.failure}`, 'Invalid token', 401, {
      aid: identity.shareableId,
      path,
      expiredBySeconds: verified.expiredBySeconds,
    })
  }
  const payload = verified.payload
  if (
    payload.aid !== identity.shareableId ||
    payload.vid !== identity.versionId
  ) {
    return deniedResponse('token_identity_mismatch', 'Invalid token', 401, {
      aid: identity.shareableId,
      vid: identity.versionId,
      tokenAid: payload.aid,
      path,
    })
  }
  if (payload.uid === null) {
    const db = createDb()
    const vis = await db
      .selectFrom('shareables')
      .select('visibility')
      .where('id', '=', payload.aid)
      .executeTakeFirst()
    if (vis?.visibility !== 'link') {
      return deniedResponse('anon_not_link', 'Invalid token', 401, {
        aid: payload.aid,
        visibility: vis?.visibility ?? null,
        path,
      })
    }
    const entrypoint = await publishedEntrypoint(db, payload, path, true)
    if (!entrypoint) {
      return deniedResponse('anon_version_mismatch', 'Invalid token', 401, {
        aid: payload.aid,
        vid: payload.vid,
        path,
      })
    }
    return await serveEntrypoint(entrypoint, false)
  }

  const db = createDb()
  // Embed tokens (MCP host preview) are reusable within their TTL — the host
  // may re-render the widget — so they skip the one-time nonce. The signature,
  // expiry, and current-version checks below still gate them. Viewer tokens
  // stay one-time.
  if (!payload.emb) {
    const existingCookie = await verifyBundleCookie(
      cookieValue(request.headers.get('Cookie'), COOKIE_NAME),
      env.BETTER_AUTH_SECRET,
    )
    const consumed = await consumeJti(
      db,
      payload.jti,
      new Date(payload.exp * 1000).toISOString(),
    )
    if (!consumed && !sameBundle(existingCookie, payload)) {
      return deniedResponse('jti_replayed', 'Invalid token', 401, {
        aid: payload.aid,
        vid: payload.vid,
        path,
        hasBundleCookie: existingCookie !== null,
        secondsUntilExp: payload.exp - Math.floor(Date.now() / 1000),
      })
    }
  }

  const entrypoint = await publishedEntrypoint(
    db,
    payload,
    path,
    payload.emb === true,
  )
  if (!entrypoint) {
    return deniedResponse('version_mismatch', 'Invalid token', 401, {
      aid: payload.aid,
      vid: payload.vid,
      fid: payload.fid,
      t: payload.t,
      path,
    })
  }

  if (entrypoint.renderType !== 'static_site') {
    return await serveEntrypoint(entrypoint, payload.emb === true)
  }

  const cookie = `${COOKIE_NAME}=${await signBundleCookie(
    {
      wid: payload.wid,
      aid: payload.aid,
      vid: payload.vid,
      exp: Math.floor(Date.now() / 1000) + COOKIE_TTL_SECONDS,
    },
    env.BETTER_AUTH_SECRET,
  )}; Path=/; Max-Age=${COOKIE_TTL_SECONDS}; HttpOnly; Secure; SameSite=None`
  const redirectTarget = sameOriginRedirectTarget(url)
  if (redirectTarget) {
    const redirect = new Response(null, {
      status: 302,
      headers: {
        Location: redirectTarget,
      },
    })
    redirect.headers.append('Set-Cookie', cookie)
    return redirect
  }

  const response = await serveEntrypoint(entrypoint, payload.emb === true)
  if (!response.ok) return response
  response.headers.append('Set-Cookie', cookie)
  return response
}

function sameOriginRedirectTarget(url: URL): string | null {
  const next = url.searchParams.get('as_next')
  if (!next) return null
  if (!next.startsWith('/') || next.startsWith('//')) return null
  let target: URL
  try {
    target = new URL(next, url.origin)
  } catch {
    return null
  }
  if (target.origin !== url.origin) return null
  const path = requestPath(target)
  if (!path) return null
  return `${encodeURI(path)}${target.search}${target.hash}`
}

interface Entrypoint {
  renderType: ArtifactType
  r2Key: string
  contentType: string | null
}

async function publishedEntrypoint(
  db: Kysely<DB>,
  payload: SandboxPayload,
  path: string,
  requireCurrent: boolean,
): Promise<Entrypoint | null> {
  const expectedKind = artifactKindForToken(payload.t)
  if (!expectedKind) return null

  const version = await db
    .selectFrom('shareables')
    .innerJoin('versions', 'versions.shareable_id', 'shareables.id')
    .select([
      'versions.artifact_kind',
      'versions.entrypoint_path',
      'versions.r2_key',
      'shareables.current_version_id',
    ])
    .where('shareables.id', '=', payload.aid)
    .where('shareables.workspace_id', '=', payload.wid)
    .where('versions.id', '=', payload.vid)
    .where('versions.status', '=', 'published')
    .where('versions.artifact_kind', '=', expectedKind)
    .executeTakeFirst()
  if (!version || version.entrypoint_path !== path) return null
  if (requireCurrent && version.current_version_id !== payload.vid) return null

  if (payload.t !== 'static_site') {
    if (version.r2_key !== payload.fid) return null
    return {
      renderType: payload.t,
      r2Key: version.r2_key,
      contentType: 'text/html; charset=utf-8',
    }
  }

  const file = await db
    .selectFrom('version_files')
    .select(['r2_key', 'mime_type'])
    .where('version_id', '=', payload.vid)
    .where('path', '=', path)
    .where('r2_key', '=', payload.fid)
    .executeTakeFirst()
  if (!file) return null
  return {
    renderType: 'static_site',
    r2Key: file.r2_key,
    contentType: file.mime_type,
  }
}

function artifactKindForToken(renderType: ArtifactType): ArtifactKind | null {
  if (renderType === 'html') return 'html_page'
  if (renderType === 'md') return 'markdown_page'
  if (renderType === 'static_site') return 'static_site'
  return null
}

function sameBundle(
  cookie: BundleCookiePayload | null,
  payload: SandboxPayload,
): boolean {
  return (
    cookie !== null &&
    cookie.wid === payload.wid &&
    cookie.aid === payload.aid &&
    cookie.vid === payload.vid
  )
}

async function serveEntrypoint(
  entrypoint: Entrypoint,
  embed: boolean,
): Promise<Response> {
  const object = await getArtifact(env.BUCKET, entrypoint.r2Key)
  if (!object) {
    return deniedResponse('r2_missing', 'This artifact is unavailable.', 404, {
      r2Key: entrypoint.r2Key,
    })
  }

  const contentType =
    object.httpMetadata?.contentType ??
    entrypoint.contentType ??
    'text/html; charset=utf-8'
  if (entrypoint.renderType === 'md' || isMarkdownContent(contentType)) {
    return documentResponse(
      renderMarkdownDocument(await object.text()),
      'text/html; charset=utf-8',
      artifactCsp(entrypoint.renderType, embed),
    )
  }

  return documentResponse(
    object.body,
    contentType,
    artifactCsp(entrypoint.renderType, embed),
  )
}

async function serveBundleAsset(
  bundle: { wid: string; aid: string; vid: string },
  path: string,
): Promise<Response> {
  const db = createDb()
  const candidatePaths = hasFileExtension(path) ? [path] : [path, '/index.html']
  const files = await db
    .selectFrom('versions')
    .innerJoin('shareables', 'shareables.id', 'versions.shareable_id')
    .innerJoin('version_files', 'version_files.version_id', 'versions.id')
    .select([
      'versions.fallback_to_index',
      'version_files.path',
      'version_files.r2_key',
      'version_files.mime_type',
    ])
    .where('shareables.id', '=', bundle.aid)
    .where('shareables.workspace_id', '=', bundle.wid)
    .where('versions.id', '=', bundle.vid)
    .where('versions.status', '=', 'published')
    .where('versions.artifact_kind', '=', 'static_site')
    .where('version_files.path', 'in', candidatePaths)
    .execute()
  const requested = files.find((file) => file.path === path)
  if (requested) return await serveBundleFile(requested)

  const fallback = files.find(
    (file) =>
      file.path === '/index.html' && Number(file.fallback_to_index) === 1,
  )
  if (!fallback) {
    return deniedResponse(
      'bundle_file_missing',
      'This artifact is unavailable.',
      404,
      { aid: bundle.aid, vid: bundle.vid, path },
    )
  }
  return await serveBundleFile(fallback)
}

async function serveAnonymousLinkBundleAsset(
  identity: { shareableId: string; versionId: string },
  path: string,
): Promise<Response> {
  const db = createDb()
  const bundle = await db
    .selectFrom('shareables')
    .innerJoin('versions', 'versions.id', 'shareables.current_version_id')
    .select([
      'shareables.workspace_id as wid',
      'shareables.id as aid',
      'shareables.owner_user_id',
      'shareables.name',
      'versions.id as vid',
    ])
    .where('shareables.id', '=', identity.shareableId)
    .where('versions.id', '=', identity.versionId)
    .where('versions.status', '=', 'published')
    .where('shareables.visibility', '=', 'link')
    .where('versions.artifact_kind', '=', 'static_site')
    .executeTakeFirst()
  if (!bundle) {
    return deniedResponse('anon_bundle_not_link', 'Invalid token', 401, {
      aid: identity.shareableId,
      path,
    })
  }
  const check = await viewerDisplayCheck(
    db,
    'link',
    null,
    {
      id: bundle.aid,
      modifiedTime: null,
      name: bundle.name,
      mimeType: 'text/html',
      ownerEmail: null,
    } satisfies ArtifactSnapshot,
    {
      shareableId: bundle.aid,
      ownerUserId: bundle.owner_user_id,
      artifactWorkspaceId: bundle.wid,
      viewerWorkspaceId: null,
      viewerEmail: null,
      viewerEmailVerified: false,
      containerId: null,
      containerKind: null,
      containerBaseVisibility: null,
    },
  )
  if (check.kind !== 'access-granted') {
    return deniedResponse('anon_bundle_unavailable', 'Invalid token', 401, {
      aid: identity.shareableId,
      path,
    })
  }
  return await serveBundleAsset(bundle, path)
}

async function serveBundleFile(file: {
  r2_key: string
  mime_type: string | null
}): Promise<Response> {
  const object = await getArtifact(env.BUCKET, file.r2_key)
  if (!object) {
    return deniedResponse('r2_missing', 'This artifact is unavailable.', 404, {
      r2Key: file.r2_key,
    })
  }

  const contentType =
    object.httpMetadata?.contentType ??
    file.mime_type ??
    'application/octet-stream'
  if (isHtmlContent(contentType)) {
    return documentResponse(
      object.body,
      contentType,
      artifactCsp('static_site'),
    )
  }
  if (isMarkdownContent(contentType)) {
    return documentResponse(
      renderMarkdownDocument(await object.text()),
      'text/html; charset=utf-8',
      artifactCsp('static_site'),
    )
  }
  return contentResponse(object.body, contentType, null)
}

function hasFileExtension(path: string): boolean {
  const lastSegment = path.split('/').at(-1) ?? ''
  return /\.[^./]+$/.test(lastSegment)
}

function requestPath(url: URL): string | null {
  let decoded: string
  try {
    decoded = decodeURIComponent(url.pathname)
  } catch {
    return null
  }
  const rawPath = decoded === '/' ? '/index.html' : decoded
  const validation = validateBundlePath(rawPath)
  if (validation.kind !== 'ok') return null
  const segments = rawPath
    .replaceAll('\\', '/')
    .split('/')
    .filter((segment) => segment !== '' && segment !== '.')
  if (segments.length === 0) return '/index.html'
  if (segments.length === 1) {
    const lower = segments[0].toLowerCase()
    if (lower === 'index.html' || lower === 'index.md') {
      segments[0] = lower
    }
  }
  return `/${segments.join('/')}`.normalize('NFC')
}

function artifactCsp(renderType: ArtifactType, embed = false): string {
  const frameAncestors = frameAncestorsValue(embed)
  const directives =
    renderType === 'md'
      ? [
          "default-src 'none'",
          `script-src 'sha256-${VIOLATION_REPORTER_SHA256}'`,
          "style-src 'unsafe-inline'",
          "img-src 'self' data: https:",
          "font-src 'self' data:",
          "connect-src 'none'",
          `frame-src ${YOUTUBE_FRAME_CSP_SOURCES}`,
        ]
      : renderType === 'html'
        ? [
            "default-src 'none'",
            `script-src 'unsafe-inline' 'unsafe-eval' ${EXTERNAL_SCRIPT_CSP_SOURCES}`,
            "style-src 'unsafe-inline' https://cdn.jsdelivr.net https://cdnjs.cloudflare.com https://unpkg.com https://fonts.googleapis.com",
            "img-src 'self' data: https: blob:",
            "font-src 'self' data: https://fonts.gstatic.com https://cdn.jsdelivr.net",
            `connect-src ${EXTERNAL_SCRIPT_CSP_SOURCES}`,
            `frame-src ${YOUTUBE_FRAME_CSP_SOURCES}`,
          ]
        : [
            "default-src 'none'",
            "script-src 'self' 'unsafe-inline'",
            `script-src-elem 'self' 'unsafe-inline' ${EXTERNAL_SCRIPT_CSP_SOURCES}`,
            "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
            "style-src-elem 'self' 'unsafe-inline' https://fonts.googleapis.com",
            "img-src 'self' data: blob:",
            "font-src 'self' data: https://fonts.gstatic.com",
            "media-src 'self'",
            `connect-src 'self' ${EXTERNAL_SCRIPT_CSP_SOURCES}`,
            `frame-src ${YOUTUBE_FRAME_CSP_SOURCES}`,
          ]
  return [
    ...directives,
    `frame-ancestors ${frameAncestors}`,
    "base-uri 'none'",
    "form-action 'none'",
    'sandbox allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox allow-downloads',
  ].join('; ')
}

function errorCsp(): string {
  return [
    "default-src 'none'",
    `frame-ancestors ${frameAncestorsValue()}`,
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; ')
}

function frameAncestorsValue(embed = false): string {
  const origins = isProduction(env)
    ? [`https://${APEX_HOST}`, `https://${WWW_HOST}`]
    : [`https://localhost:${APP_DEV_PORT}`]
  // Embed-token previews are framed from the MCP host's widget sandbox, so the
  // content must name those origins as valid ancestors — only for embed tokens.
  if (embed) origins.push(...MCP_EMBED_FRAME_ANCESTORS)
  return origins.join(' ')
}

function isHtmlContent(contentType: string): boolean {
  return contentType.toLowerCase().startsWith('text/html')
}

function isMarkdownContent(contentType: string): boolean {
  return contentType.toLowerCase().startsWith('text/markdown')
}

type ViolationReporterElement = Pick<Element, 'before'>
type ViolationReporterDocumentEnd = Pick<DocumentEnd, 'append'>

export function createViolationReporterHandler() {
  let injected = false
  return {
    element(element: ViolationReporterElement) {
      if (injected) return
      injected = true
      // Inject before the first element: prepending inside a raw-text element
      // makes the script non-executable, while injecting later can miss early
      // CSP violations from the artifact's own scripts.
      element.before(VIOLATION_REPORTER_TAG, { html: true })
    },
    end(documentEnd: ViolationReporterDocumentEnd) {
      if (injected) return
      injected = true
      documentEnd.append(VIOLATION_REPORTER_TAG, { html: true })
    },
  }
}

function documentResponse(
  body: string | ReadableStream<Uint8Array> | null,
  contentType: string,
  csp: string,
): Response {
  const response = contentResponse(body, contentType, csp)
  if (typeof HTMLRewriter === 'undefined') {
    if (typeof body !== 'string') return response
    return contentResponse(injectReadyReporter(body), contentType, csp)
  }
  const handler = createViolationReporterHandler()
  return new HTMLRewriter()
    .on('*', handler)
    .onDocument(handler)
    .transform(response)
}

export function injectReadyReporter(html: string): string {
  // Keep the document mode and place the reporter before every authored node.
  const doctype = html.match(/^(?:\s|<!--[\s\S]*?-->)*<!doctype(?:\s[^>]*)?>/i)
  const insertionPoint = doctype?.[0].length ?? 0
  return `${html.slice(0, insertionPoint)}${VIOLATION_REPORTER_TAG}${html.slice(insertionPoint)}`
}

function contentResponse(
  body: string | ReadableStream<Uint8Array> | null,
  contentType: string,
  csp: string | null,
): Response {
  const response = new Response(body, {
    headers: {
      'Content-Type': contentType,
      'Cache-Control': 'private, no-store, no-transform',
      'Cross-Origin-Resource-Policy': 'same-site',
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Permissions-Policy': PERMISSIONS_POLICY,
      'Referrer-Policy': REFERRER_POLICY,
      [ROBOTS_HEADER]: ROBOTS_VALUE,
      'X-Content-Type-Options': 'nosniff',
    },
  })
  if (csp) response.headers.set(CSP_HEADER, csp)
  return response
}

function deniedResponse(
  reason: string,
  message: string,
  status: number,
  detail: Record<string, unknown>,
): Response {
  console.warn('sandbox_denied', { reason, status, ...detail })
  return errorResponse(message, status)
}

function errorResponse(message: string, status: number): Response {
  return new Response(message, {
    status,
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'private, no-store, no-transform',
      'Cross-Origin-Resource-Policy': 'same-site',
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Permissions-Policy': PERMISSIONS_POLICY,
      [CSP_HEADER]: errorCsp(),
      'Referrer-Policy': REFERRER_POLICY,
      [ROBOTS_HEADER]: ROBOTS_VALUE,
      'X-Content-Type-Options': 'nosniff',
    },
  })
}

function cookieValue(header: string | null, name: string): string | null {
  if (!header) return null
  for (const part of header.split(';')) {
    const [rawName, ...rawValue] = part.trim().split('=')
    if (rawName === name) return rawValue.join('=') || null
  }
  return null
}

async function signBundleCookie(
  payload: BundleCookiePayload,
  secret: string,
): Promise<string> {
  const body = encodeBase64Url(ENCODER.encode(JSON.stringify(payload)))
  const sig = encodeBase64Url(await hmac(secret, body))
  return `${body}.${sig}`
}

async function verifyBundleCookie(
  value: string | null,
  secret: string,
): Promise<BundleCookiePayload | null> {
  if (!value) return null
  const dot = value.indexOf('.')
  if (dot < 0) return null
  const body = value.slice(0, dot)
  const sig = value.slice(dot + 1)
  const expected = encodeBase64Url(await hmac(secret, body))
  if (!constantTimeEqual(sig, expected)) return null

  let payload: BundleCookiePayload
  try {
    payload = JSON.parse(DECODER.decode(decodeBase64Url(body)))
  } catch {
    return null
  }
  if (
    typeof payload.wid !== 'string' ||
    typeof payload.aid !== 'string' ||
    typeof payload.vid !== 'string' ||
    typeof payload.exp !== 'number' ||
    payload.exp < Math.floor(Date.now() / 1000)
  ) {
    return null
  }
  return payload
}

const keyCache = new Map<string, Promise<CryptoKey>>()

function getKey(secret: string): Promise<CryptoKey> {
  let cached = keyCache.get(secret)
  if (!cached) {
    cached = crypto.subtle.importKey(
      'raw',
      ENCODER.encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    )
    keyCache.set(secret, cached)
  }
  return cached
}

async function hmac(secret: string, message: string): Promise<ArrayBuffer> {
  const key = await getKey(secret)
  return crypto.subtle.sign('HMAC', key, ENCODER.encode(message))
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  }
  return diff === 0
}
