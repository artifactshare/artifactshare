import { env } from 'cloudflare:workers'
import { sql, type Kysely } from 'kysely'
import type { ArtifactType } from '../app/lib/artifact-type'
import { decodeBase64Url, encodeBase64Url } from '../app/lib/base64url'
import { lowerEmail } from '../app/lib/grant-emails.server'
import {
  APEX_HOST,
  APP_DEV_PORT,
  isProduction,
  MCP_EMBED_FRAME_ANCESTORS,
  linkViewerOrigin,
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
import { checkAnonymousLinkAccess } from '../app/services/link-sharing.server'
import { consumeJti } from '../app/services/sandbox-jti.server'
import { getArtifact, headArtifact } from '../app/services/storage.server'
import {
  viewerAccessAllowed,
  viewerDisplayCheck,
  type ViewerAccessFacts,
} from '../app/services/access.server'
import type { ArtifactSnapshot } from '../app/services/access.server'
import type { DB } from '../app/types/db'
import {
  VIOLATION_REPORTER_SHA256,
  VIOLATION_REPORTER_TAG,
} from '../app/lib/csp-reporter'
import { injectReadyReporter } from '@artifactshare/viewer-kit/inject'

export { injectReadyReporter }
import { validateBundlePath } from './lib/path-validator'
import {
  SANDBOX_PROBE_MARKER,
  SANDBOX_PROBE_PATH,
} from '../app/lib/sandbox-block-report'

const COOKIE_NAME = 'as_bnd'
// Anonymous link bundle grants may outlive a visibility change by this bounded
// interval; the next entrypoint or expired-cookie asset request rechecks D1.
const COOKIE_TTL_SECONDS = 10 * 60
const CSP_HEADER = 'Content-Security-Policy'
const ROBOTS_HEADER = 'X-Robots-Tag'
const ROBOTS_VALUE = 'noindex, nofollow'
const REFERRER_POLICY = 'strict-origin'
const EXTERNAL_SCRIPT_CSP_SOURCES =
  'https://cdn.jsdelivr.net https://cdnjs.cloudflare.com https://unpkg.com https://esm.sh https://cdn.tailwindcss.com'
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
const PERMISSIONS_POLICY = `fullscreen=(self ${EMBED_FULLSCREEN_PERMISSIONS_POLICY_SOURCES}), clipboard-write=(self), camera=(), microphone=(), geolocation=(), display-capture=(), payment=(), usb=(), serial=(), hid=(), midi=()`
const MEDIA_CSP_SOURCES = "'self' https: data: blob:"
const ENCODER = new TextEncoder()
const DECODER = new TextDecoder()

interface BundleCookiePayload {
  uid: string | null
  wid: string
  aid: string
  vid: string
  exp: number
  fallbackToIndex?: boolean
  r2Prefix?: string
}

type AnonymousBundleCookiePayload = BundleCookiePayload & {
  uid: null
  fallbackToIndex: boolean
  r2Prefix: string
}

type SandboxIdentity = NonNullable<
  ReturnType<typeof sandboxVersionIdentityFromHostname>
>
type SandboxResponseDomain = Pick<SandboxIdentity, 'shareableId' | 'domain'>

export async function handleArtifactSandboxRequest(
  request: Request,
  _ctx?: ExecutionContext,
): Promise<Response> {
  const url = new URL(request.url)
  const hostname = requestHostname(request, env)
  const identity = sandboxVersionIdentityFromHostname(hostname, env)
  if (url.pathname === SANDBOX_PROBE_PATH)
    return sandboxProbeResponse(request, identity)
  if (!identity) {
    return deniedResponse('bad_hostname', 'Not found', 404, { hostname })
  }

  const path = requestPath(url)
  if (!path) {
    return deniedResponse(
      'bad_path',
      'Not found',
      404,
      { aid: identity.shareableId, pathname: url.pathname },
      identity,
    )
  }

  const token = url.searchParams.get('t')
  if (token) {
    return await handleEntrypointRequest(request, url, identity, path, token)
  }

  const cookieResult = await verifyBundleCookie(
    cookieValue(request.headers.get('Cookie'), COOKIE_NAME),
    env.BETTER_AUTH_SECRET,
  )
  if (cookieResult.kind === 'valid') {
    const cookie = cookieResult.payload
    if (
      identity !== null &&
      (cookie.aid !== identity.shareableId || cookie.vid !== identity.versionId)
    ) {
      return deniedResponse(
        'cookie_identity_mismatch',
        'Invalid token',
        401,
        {
          aid: identity.shareableId,
          vid: identity.versionId,
          cookieAid: cookie.aid,
          path,
        },
        identity,
      )
    }
    if (cookie.uid === null) {
      if (!isAnonymousBundleCookie(cookie)) {
        return deniedResponse(
          'anonymous_cookie_invalid',
          'Invalid token',
          401,
          { aid: identity.shareableId, vid: identity.versionId, path },
          identity,
        )
      }
      if (identity.domain !== 'link' && isProduction(env)) {
        return deniedResponse(
          'anonymous_cookie_wrong_domain',
          'Invalid token',
          401,
          {
            aid: identity.shareableId,
            vid: identity.versionId,
            path,
          },
          anonymousResponseDomain(identity),
        )
      }
      return await serveAnonymousCookieBundleAsset(
        cookie,
        path,
        request,
        anonymousResponseDomain(identity),
      )
    }
    if (identity.domain === 'link') {
      // Authenticated cookies are host-scoped in normal browsers, but do not
      // allow a manually replayed viewer cookie to become a link grant.
      return await serveAnonymousLinkBundleAsset(identity, path, request)
    }
    return await serveBundleAsset(cookie, path, request)
  }

  return await serveAnonymousLinkBundleAsset(identity, path, request)
}

function sandboxProbeResponse(
  request: Request,
  identity: SandboxIdentity | null,
): Response {
  const origin = request.headers.get('Origin')
  const allowed = new Set([
    `https://${APEX_HOST}`,
    `https://${WWW_HOST}`,
    `https://localhost:${APP_DEV_PORT}`,
  ])
  if (identity && (identity.domain === 'link' || !isProduction(env))) {
    allowed.add(linkViewerOrigin(isProduction(env), identity.shareableId))
  }
  const headers = new Headers({
    'Cache-Control': 'private, no-store, no-transform',
    'Content-Type': 'text/plain; charset=utf-8',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Resource-Policy':
      identity?.domain === 'link' ? 'cross-origin' : 'same-site',
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
  identity: SandboxIdentity,
  path: string,
  token: string,
): Promise<Response> {
  const verified = await verifySandboxTokenDetailed(
    token,
    env.BETTER_AUTH_SECRET,
  )
  if (!verified.ok) {
    return deniedResponse(
      `token_${verified.failure}`,
      'Invalid token',
      401,
      {
        aid: identity.shareableId,
        path,
        expiredBySeconds: verified.expiredBySeconds,
      },
      identity,
    )
  }
  const payload = verified.payload
  if (
    payload.aid !== identity.shareableId ||
    payload.vid !== identity.versionId
  ) {
    return deniedResponse(
      'token_identity_mismatch',
      'Invalid token',
      401,
      {
        aid: identity.shareableId,
        vid: identity.versionId,
        tokenAid: payload.aid,
        path,
      },
      identity,
    )
  }
  if (identity.domain === 'link' && payload.uid !== null) {
    return deniedResponse(
      'link_domain_requires_anonymous',
      'Invalid token',
      401,
      { aid: identity.shareableId, path },
      identity,
    )
  }
  if (payload.uid === null) {
    const responseDomain = anonymousResponseDomain(identity)
    const db = createDb()
    const linkAccess = await checkAnonymousLinkAccess(db, payload.aid)
    if (linkAccess.kind !== 'allowed') {
      return deniedResponse(
        'anon_not_link',
        'Invalid token',
        401,
        { aid: payload.aid, linkAccess: linkAccess.kind, path },
        responseDomain,
      )
    }
    const entrypoint = await publishedEntrypoint(db, payload, path, true)
    if (!entrypoint) {
      return deniedResponse(
        'anon_version_mismatch',
        'Invalid token',
        401,
        { aid: payload.aid, vid: payload.vid, path },
        responseDomain,
      )
    }
    const response = await serveEntrypoint(entrypoint, false, responseDomain)
    if (
      !response.ok ||
      entrypoint.renderType !== 'static_site' ||
      !entrypoint.r2Prefix
    )
      return response
    response.headers.append(
      'Set-Cookie',
      await bundleCookieFor(payload, entrypoint),
    )
    return response
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
    if (
      !consumed &&
      !sameBundle(
        existingCookie.kind === 'valid' ? existingCookie.payload : null,
        payload,
      )
    ) {
      return deniedResponse('jti_replayed', 'Invalid token', 401, {
        aid: payload.aid,
        vid: payload.vid,
        path,
        hasBundleCookie: existingCookie.kind === 'valid',
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

  if (!(await authenticatedSandboxAccess(db, payload))) {
    return deniedResponse('viewer_access_revoked', 'Invalid token', 401, {
      aid: payload.aid,
      vid: payload.vid,
      path,
    })
  }

  if (entrypoint.renderType !== 'static_site') {
    return await serveEntrypoint(entrypoint, payload.emb === true)
  }

  const cookie = await bundleCookieFor(payload, entrypoint)
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
  fallbackToIndex: boolean
  r2Prefix: string | null
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
      'versions.fallback_to_index',
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
      fallbackToIndex: false,
      r2Prefix: null,
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
  const r2Prefix = staticSiteR2PrefixFromEntrypoint(file.r2_key, path)
  if (!r2Prefix) return null
  return {
    renderType: 'static_site',
    r2Key: file.r2_key,
    contentType: file.mime_type,
    fallbackToIndex: Number(version.fallback_to_index) === 1,
    r2Prefix,
  }
}

function staticSiteR2PrefixFromEntrypoint(
  r2Key: string,
  path: string,
): string | null {
  const suffix = path.slice(1)
  if (!suffix || !r2Key.endsWith(suffix)) return null
  return r2Key.slice(0, -suffix.length)
}

async function bundleCookieFor(
  payload: SandboxPayload,
  entrypoint: Entrypoint,
): Promise<string> {
  const cookiePayload: BundleCookiePayload = {
    uid: payload.uid,
    wid: payload.wid,
    aid: payload.aid,
    vid: payload.vid,
    exp: Math.floor(Date.now() / 1000) + COOKIE_TTL_SECONDS,
  }
  if (payload.uid === null) {
    if (!entrypoint.r2Prefix) throw new Error('Missing static-site R2 prefix')
    cookiePayload.fallbackToIndex = entrypoint.fallbackToIndex
    cookiePayload.r2Prefix = entrypoint.r2Prefix
  }
  const value = await signBundleCookie(cookiePayload, env.BETTER_AUTH_SECRET)
  return `${COOKIE_NAME}=${value}; Path=/; Max-Age=${COOKIE_TTL_SECONDS}; HttpOnly; Secure; SameSite=None`
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
    cookie.uid === payload.uid &&
    cookie.wid === payload.wid &&
    cookie.aid === payload.aid &&
    cookie.vid === payload.vid
  )
}

async function serveEntrypoint(
  entrypoint: Entrypoint,
  embed: boolean,
  responseDomain?: SandboxResponseDomain,
): Promise<Response> {
  const object = await getArtifact(env.BUCKET, entrypoint.r2Key)
  if (!object) {
    return deniedResponse(
      'r2_missing',
      'This artifact is unavailable.',
      404,
      { r2Key: entrypoint.r2Key },
      responseDomain,
    )
  }

  const contentType =
    object.httpMetadata?.contentType ??
    entrypoint.contentType ??
    'text/html; charset=utf-8'
  if (entrypoint.renderType === 'md' || isMarkdownContent(contentType)) {
    return documentResponse(
      renderMarkdownDocument(await object.text()),
      'text/html; charset=utf-8',
      artifactCsp(entrypoint.renderType, embed, responseDomain),
      responseDomain,
    )
  }

  return documentResponse(
    object.body,
    contentType,
    artifactCsp(entrypoint.renderType, embed, responseDomain),
    responseDomain,
  )
}

async function serveBundleAsset(
  bundle: { uid?: string | null; wid: string; aid: string; vid: string },
  path: string,
  request: Request,
  responseDomain?: SandboxResponseDomain,
): Promise<Response> {
  const db = createDb()
  const candidatePaths = hasFileExtension(path) ? [path] : [path, '/index.html']
  const viewerId = bundle.uid ?? ''
  const now = new Date().toISOString()
  const files = await db
    .selectFrom('versions')
    .innerJoin('shareables', 'shareables.id', 'versions.shareable_id')
    .leftJoin('version_files', (join) =>
      join
        .onRef('version_files.version_id', '=', 'versions.id')
        .on('version_files.path', 'in', candidatePaths),
    )
    .select([
      'versions.fallback_to_index',
      'version_files.path',
      'version_files.r2_key',
      'version_files.mime_type',
      'version_files.size_bytes',
    ])
    .$if(Boolean(bundle.uid), (query) =>
      query
        .leftJoin('users as sandbox_viewer', (join) =>
          join.on('sandbox_viewer.id', '=', viewerId),
        )
        .select(sandboxViewerFactSelections(now)),
    )
    .where('shareables.id', '=', bundle.aid)
    .where('shareables.workspace_id', '=', bundle.wid)
    .where('versions.id', '=', bundle.vid)
    .where('versions.status', '=', 'published')
    .where('versions.artifact_kind', '=', 'static_site')
    .$if(!bundle.uid, (query) =>
      query
        .where('shareables.visibility', '=', 'link')
        .where('shareables.link_suspended_at', 'is', null)
        .where(activeLinkExpiry(now))
        .where((eb) =>
          eb.exists(
            eb
              .selectFrom('workspaces')
              .select('workspaces.id')
              .whereRef('workspaces.id', '=', 'shareables.workspace_id')
              .where('workspaces.link_sharing_enabled', '=', 1),
          ),
        ),
    )
    .execute()
  if (
    bundle.uid &&
    files[0] &&
    !sandboxAccessRowAllowed(files[0] as SandboxAccessRow, bundle.uid)
  ) {
    return deniedResponse('viewer_access_revoked', 'Invalid token', 401, {
      aid: bundle.aid,
      vid: bundle.vid,
      path,
    })
  }
  const requested = files.find(
    (file): file is typeof file & { r2_key: string; size_bytes: number } =>
      file.path === path && file.r2_key !== null && file.size_bytes !== null,
  )
  if (requested)
    return await serveBundleFile(requested, request, responseDomain)

  const fallback = files.find(
    (file): file is typeof file & { r2_key: string; size_bytes: number } =>
      file.path === '/index.html' &&
      file.r2_key !== null &&
      file.size_bytes !== null &&
      Number(file.fallback_to_index) === 1,
  )
  if (!fallback) {
    return deniedResponse(
      'bundle_file_missing',
      'This artifact is unavailable.',
      404,
      { aid: bundle.aid, vid: bundle.vid, path },
      responseDomain,
    )
  }
  return await serveBundleFile(fallback, request, responseDomain)
}

async function serveAnonymousCookieBundleAsset(
  bundle: AnonymousBundleCookiePayload,
  path: string,
  request: Request,
  responseDomain: SandboxResponseDomain,
): Promise<Response> {
  const candidates = [
    { path, key: `${bundle.r2Prefix}${path.slice(1)}` },
    ...(!hasFileExtension(path) && bundle.fallbackToIndex
      ? [{ path: '/index.html', key: `${bundle.r2Prefix}index.html` }]
      : []),
  ]

  for (const candidate of candidates) {
    const object = await headArtifact(env.BUCKET, candidate.key)
    if (!object) continue
    return await serveBundleFile(
      {
        r2_key: candidate.key,
        mime_type: object.httpMetadata?.contentType ?? null,
        size_bytes: object.size,
      },
      request,
      responseDomain,
    )
  }

  return deniedResponse(
    'bundle_file_missing',
    'This artifact is unavailable.',
    404,
    { aid: bundle.aid, vid: bundle.vid, path },
    responseDomain,
  )
}

function isAnonymousBundleCookie(
  payload: BundleCookiePayload,
): payload is AnonymousBundleCookiePayload {
  return (
    payload.uid === null &&
    typeof payload.fallbackToIndex === 'boolean' &&
    typeof payload.r2Prefix === 'string' &&
    payload.r2Prefix.length > 0 &&
    payload.r2Prefix.endsWith('/')
  )
}

function activeLinkExpiry(now: string) {
  return sql<boolean>`(shareables.link_expires_at IS NULL OR (
    strftime('%Y-%m-%dT%H:%M:%S', shareables.link_expires_at) = substr(shareables.link_expires_at, 1, 19)
    AND substr(shareables.link_expires_at, -1) = 'Z'
    AND substr(shareables.link_expires_at, 12, 2) BETWEEN '00' AND '23'
    AND (
      length(shareables.link_expires_at) = 20
      OR (
        length(shareables.link_expires_at) > 21
        AND substr(shareables.link_expires_at, 20, 1) = '.'
        AND substr(shareables.link_expires_at, 21, length(shareables.link_expires_at) - 21) NOT GLOB '*[^0-9]*'
      )
    )
    AND julianday(shareables.link_expires_at) > julianday(${now})
  ))`
}

async function authenticatedSandboxAccess(
  db: Kysely<DB>,
  payload: SandboxPayload,
): Promise<boolean> {
  if (!payload.uid) return false
  const row = await db
    .selectFrom('shareables')
    .innerJoin('users as sandbox_viewer', (join) =>
      join.on('sandbox_viewer.id', '=', payload.uid!),
    )
    .select(sandboxViewerFactSelections(new Date().toISOString()))
    .where('shareables.id', '=', payload.aid)
    .where('shareables.workspace_id', '=', payload.wid)
    .executeTakeFirst()
  return Boolean(row && sandboxAccessRowAllowed(row, payload.uid))
}

type SandboxAccessRow = {
  visibility: string
  owner_user_id: string
  artifact_workspace_id: string
  container_kind: string | null
  container_base_visibility: string | null
  anonymous_link_allowed: number
  viewer_exists: number
  viewer_workspace_id: string | null
  viewer_email_verified: number
  is_team_admin: number
  has_shareable_grant: number
  is_project_creator: number
  is_project_admin: number
  has_project_grant: number
}

function sandboxViewerFactSelections(now: string) {
  return [
    sql<string>`shareables.visibility`.as('visibility'),
    sql<string>`shareables.owner_user_id`.as('owner_user_id'),
    sql<string>`shareables.workspace_id`.as('artifact_workspace_id'),
    sql<
      string | null
    >`(SELECT kind FROM artifact_containers WHERE id = shareables.container_id)`.as(
      'container_kind',
    ),
    sql<
      string | null
    >`(SELECT base_visibility FROM artifact_containers WHERE id = shareables.container_id)`.as(
      'container_base_visibility',
    ),
    sql<number>`CASE WHEN shareables.visibility = 'link'
      AND shareables.link_suspended_at IS NULL
      AND (${activeLinkExpiry(now)})
      AND EXISTS(
        SELECT 1 FROM workspaces link_workspace
        WHERE link_workspace.id = shareables.workspace_id
          AND link_workspace.link_sharing_enabled = 1
    ) THEN 1 ELSE 0 END`.as('anonymous_link_allowed'),
    sql<number>`CASE WHEN sandbox_viewer.id IS NULL THEN 0 ELSE 1 END`.as(
      'viewer_exists',
    ),
    sql<string | null>`sandbox_viewer.workspace_id`.as('viewer_workspace_id'),
    sql<number>`sandbox_viewer.email_verified`.as('viewer_email_verified'),
    sql<number>`EXISTS(SELECT 1 FROM workspace_members wm JOIN workspaces w ON w.id = wm.workspace_id WHERE wm.workspace_id = shareables.workspace_id AND wm.user_id = sandbox_viewer.id AND sandbox_viewer.workspace_id = shareables.workspace_id AND wm.status = 'active' AND wm.role IN ('owner', 'admin') AND w.plan = 'team')`.as(
      'is_team_admin',
    ),
    sql<number>`EXISTS(SELECT 1 FROM shareable_grants sg WHERE sg.shareable_id = shareables.id AND ${lowerEmail('sg.granted_email')} = ${lowerEmail('sandbox_viewer.email')})`.as(
      'has_shareable_grant',
    ),
    sql<number>`EXISTS(SELECT 1 FROM artifact_containers ac WHERE ac.id = shareables.container_id AND ac.kind = 'project' AND ac.created_by_id = sandbox_viewer.id)`.as(
      'is_project_creator',
    ),
    sql<number>`EXISTS(SELECT 1 FROM artifact_containers ac JOIN workspace_members wm ON wm.workspace_id = ac.workspace_id JOIN workspaces w ON w.id = ac.workspace_id WHERE ac.id = shareables.container_id AND ac.kind = 'project' AND wm.user_id = sandbox_viewer.id AND sandbox_viewer.workspace_id = ac.workspace_id AND wm.status = 'active' AND wm.role IN ('owner', 'admin') AND w.plan = 'team')`.as(
      'is_project_admin',
    ),
    sql<number>`EXISTS(SELECT 1 FROM project_share_defaults psd WHERE psd.project_container_id = shareables.container_id AND ${lowerEmail('psd.email')} = ${lowerEmail('sandbox_viewer.email')})`.as(
      'has_project_grant',
    ),
  ] as const
}

function sandboxAccessRowAllowed(
  row: SandboxAccessRow,
  viewerUserId: string,
): boolean {
  if (row.viewer_exists !== 1) return false
  return viewerAccessAllowed({
    visibility: row.visibility as ViewerAccessFacts['visibility'],
    viewerUserId,
    ownerUserId: row.owner_user_id,
    viewerWorkspaceId: row.viewer_workspace_id,
    artifactWorkspaceId: row.artifact_workspace_id,
    viewerEmailVerified: row.viewer_email_verified === 1,
    anonymousLinkAllowed: row.anonymous_link_allowed === 1,
    isTeamAdmin: row.is_team_admin === 1,
    hasShareableGrant: row.has_shareable_grant === 1,
    containerKind: row.container_kind as ViewerAccessFacts['containerKind'],
    containerBaseVisibility:
      row.container_base_visibility as ViewerAccessFacts['containerBaseVisibility'],
    isProjectCreator: row.is_project_creator === 1,
    isProjectAdmin: row.is_project_admin === 1,
    hasProjectGrant: row.has_project_grant === 1,
  })
}

async function serveAnonymousLinkBundleAsset(
  identity: SandboxIdentity,
  path: string,
  request: Request,
): Promise<Response> {
  const responseDomain = anonymousResponseDomain(identity)
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
    return deniedResponse(
      'anon_bundle_not_link',
      'Invalid token',
      401,
      { aid: identity.shareableId, path },
      responseDomain,
    )
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
    return deniedResponse(
      'anon_bundle_unavailable',
      'Invalid token',
      401,
      { aid: identity.shareableId, path },
      responseDomain,
    )
  }
  return await serveBundleAsset(bundle, path, request, responseDomain)
}

async function serveBundleFile(
  file: {
    r2_key: string
    mime_type: string | null
    size_bytes: number
  },
  request: Request,
  responseDomain?: SandboxResponseDomain,
): Promise<Response> {
  const transformsDocument =
    file.mime_type === null ||
    isHtmlContent(file.mime_type) ||
    isMarkdownContent(file.mime_type)
  const requestedRange =
    !transformsDocument && request.headers.has('Range')
      ? request.headers
      : undefined
  const rangeSatisfiability = requestedRange
    ? rangeSatisfiabilityFor(requestedRange.get('Range'), file.size_bytes)
    : null
  if (rangeSatisfiability === false) {
    return rangeNotSatisfiableResponse(file.size_bytes, responseDomain)
  }
  const range = rangeSatisfiability === true ? requestedRange : undefined
  const object = range
    ? await getArtifact(env.BUCKET, file.r2_key, { range })
    : await getArtifact(env.BUCKET, file.r2_key)
  if (!object) {
    return deniedResponse(
      'r2_missing',
      'This artifact is unavailable.',
      404,
      { r2Key: file.r2_key },
      responseDomain,
    )
  }

  const contentType =
    object.httpMetadata?.contentType ??
    file.mime_type ??
    'application/octet-stream'
  if (isHtmlContent(contentType)) {
    return documentResponse(
      object.body,
      contentType,
      artifactCsp('static_site', false, responseDomain),
      responseDomain,
    )
  }
  if (isMarkdownContent(contentType)) {
    return documentResponse(
      renderMarkdownDocument(await object.text()),
      'text/html; charset=utf-8',
      artifactCsp('static_site', false, responseDomain),
      responseDomain,
    )
  }
  const rangeHeader = range?.get('Range') ?? null
  return contentResponse(
    object.body,
    contentType,
    null,
    {
      status: rangeHeader ? 206 : 200,
      headers: rangeResponseHeaders(object.size, rangeHeader),
    },
    responseDomain,
  )
}

function rangeSatisfiabilityFor(
  value: string | null,
  size: number,
): boolean | null {
  const match = value?.match(/^bytes=(\d*)-(\d*)$/)
  if (!match) return null
  if (size === 0) return false
  const [, startValue, endValue] = match
  if (startValue === '') {
    return BigInt(endValue) > 0n
  }
  const start = BigInt(startValue)
  if (start >= BigInt(size)) return false
  if (endValue === '') return true
  return BigInt(endValue) >= start
}

function rangeNotSatisfiableResponse(
  size: number,
  responseDomain?: SandboxResponseDomain,
): Response {
  return contentResponse(
    null,
    'text/plain; charset=utf-8',
    null,
    {
      status: 416,
      headers: new Headers({
        'Accept-Ranges': 'bytes',
        'Content-Length': '0',
        'Content-Range': `bytes */${size}`,
      }),
    },
    responseDomain,
  )
}

function rangeResponseHeaders(size: number, value: string | null): Headers {
  const headers = new Headers({ 'Accept-Ranges': 'bytes' })
  if (!value) {
    headers.set('Content-Length', String(size))
    return headers
  }

  const resolved = resolveRequestedRange(value, size)
  headers.set('Content-Length', String(resolved.length))
  headers.set(
    'Content-Range',
    `bytes ${resolved.start}-${resolved.start + resolved.length - 1}/${size}`,
  )
  return headers
}

function resolveRequestedRange(
  value: string,
  size: number,
): { start: number; length: number } {
  const match = value.match(/^bytes=(\d*)-(\d*)$/)
  if (!match) throw new Error('Validated byte range did not parse')
  const [, startValue, endValue] = match
  if (startValue === '') {
    const length = Number(
      BigInt(endValue) > BigInt(size) ? BigInt(size) : BigInt(endValue),
    )
    return { start: size - length, length }
  }
  const start = Number(BigInt(startValue))
  const end =
    endValue === '' || BigInt(endValue) >= BigInt(size)
      ? size - 1
      : Number(BigInt(endValue))
  return { start, length: end - start + 1 }
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

function artifactCsp(
  renderType: ArtifactType,
  embed = false,
  responseDomain?: SandboxResponseDomain,
): string {
  const frameAncestors = frameAncestorsValue(embed, responseDomain)
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
            "script-src 'self' 'unsafe-inline'",
            `script-src-elem 'self' 'unsafe-inline' ${EXTERNAL_SCRIPT_CSP_SOURCES} ${SOCIAL_EMBED_SCRIPT_CSP_SOURCES}`,
            "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
            `style-src-elem 'self' 'unsafe-inline' https://fonts.googleapis.com ${SOCIAL_EMBED_STYLE_CSP_SOURCES}`,
            "img-src 'self' data: blob:",
            "font-src 'self' data: https://fonts.gstatic.com",
            `media-src ${MEDIA_CSP_SOURCES}`,
            `connect-src 'self' ${EXTERNAL_SCRIPT_CSP_SOURCES} ${SOCIAL_EMBED_CONNECT_CSP_SOURCES}`,
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

function errorCsp(responseDomain?: SandboxResponseDomain): string {
  return [
    "default-src 'none'",
    `frame-ancestors ${frameAncestorsValue(false, responseDomain)}`,
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; ')
}

function frameAncestorsValue(
  embed = false,
  responseDomain?: SandboxResponseDomain,
): string {
  const origins =
    responseDomain?.domain === 'link'
      ? [linkViewerOrigin(isProduction(env), responseDomain.shareableId)]
      : isProduction(env)
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
  responseDomain?: SandboxResponseDomain,
): Response {
  const response = contentResponse(
    body,
    contentType,
    csp,
    undefined,
    responseDomain,
  )
  if (typeof HTMLRewriter === 'undefined') {
    if (typeof body !== 'string') return response
    return contentResponse(
      injectReadyReporter(body),
      contentType,
      csp,
      undefined,
      responseDomain,
    )
  }
  const handler = createViolationReporterHandler()
  return new HTMLRewriter()
    .on('*', handler)
    .onDocument(handler)
    .transform(response)
}

function contentResponse(
  body: string | ReadableStream<Uint8Array> | null,
  contentType: string,
  csp: string | null,
  init?: { status?: number; headers?: Headers },
  responseDomain?: SandboxResponseDomain,
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

function deniedResponse(
  reason: string,
  message: string,
  status: number,
  detail: Record<string, unknown>,
  responseDomain?: SandboxResponseDomain,
): Response {
  console.warn('sandbox_denied', { reason, status, ...detail })
  return errorResponse(message, status, responseDomain)
}

function errorResponse(
  message: string,
  status: number,
  responseDomain?: SandboxResponseDomain,
): Response {
  return new Response(message, {
    status,
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'private, no-store, no-transform',
      'Cross-Origin-Resource-Policy':
        responseDomain?.domain === 'link' ? 'cross-origin' : 'same-site',
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Permissions-Policy': PERMISSIONS_POLICY,
      [CSP_HEADER]: errorCsp(responseDomain),
      'Referrer-Policy': REFERRER_POLICY,
      [ROBOTS_HEADER]: ROBOTS_VALUE,
      'X-Content-Type-Options': 'nosniff',
    },
  })
}

function anonymousResponseDomain(
  identity: SandboxIdentity,
): SandboxResponseDomain {
  return {
    shareableId: identity.shareableId,
    domain:
      identity.domain === 'link' || !isProduction(env) ? 'link' : 'sandbox',
  }
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
): Promise<
  | { kind: 'valid'; payload: BundleCookiePayload }
  | { kind: 'absent-or-invalid' }
> {
  if (!value) return { kind: 'absent-or-invalid' }
  const dot = value.indexOf('.')
  if (dot < 0) return { kind: 'absent-or-invalid' }
  const body = value.slice(0, dot)
  const sig = value.slice(dot + 1)
  const expected = encodeBase64Url(await hmac(secret, body))
  if (!constantTimeEqual(sig, expected)) return { kind: 'absent-or-invalid' }

  let payload: BundleCookiePayload
  try {
    payload = JSON.parse(DECODER.decode(decodeBase64Url(body)))
  } catch {
    return { kind: 'absent-or-invalid' }
  }
  if (
    (payload.uid !== null &&
      (typeof payload.uid !== 'string' || payload.uid.length === 0)) ||
    typeof payload.wid !== 'string' ||
    typeof payload.aid !== 'string' ||
    typeof payload.vid !== 'string' ||
    typeof payload.exp !== 'number' ||
    payload.exp <= Math.floor(Date.now() / 1000)
  ) {
    return { kind: 'absent-or-invalid' }
  }
  if (payload.uid === null && !isAnonymousBundleCookie(payload)) {
    return { kind: 'absent-or-invalid' }
  }
  return { kind: 'valid', payload }
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
