import { createRequestHandler, RouterContextProvider } from 'react-router'
import {
  APEX_HOST,
  isProduction,
  requestHostname,
  WWW_HOST,
} from '../app/lib/hosts'
import { isAuthCookieName } from '../app/lib/auth-cookies'
import {
  isPublicPagePath,
  normalizeGuidePathname,
} from '../app/lib/guide-locale'
import { ctxContext } from '../app/middleware/context'
import { anchorAuthInit, getSessionUser } from '../app/services/auth.server'
import { loadCommentAccess } from '../app/services/comments.server'
import { createDb } from '../app/services/db.server'
import {
  createStripeClient,
  type BillingEnv,
} from '../app/services/billing.server'
import {
  runReconciliation,
  type ReconciliationOptions,
} from '../app/services/reconcile.server'
import { getOwnerInitial } from '../app/lib/user'
import { MAINTENANCE_REQUEST_HEADER } from '../app/lib/maintenance'
import { evaluateFlagshipFlag } from '../app/lib/flagship-fallback.server'
import { handlePostUploadWorkflowSpike } from './post-upload-workflow-spike'
import { handleD1BackupWorkflow } from './d1-backup-workflow-route'
import {
  processSlackNotificationOutbox,
  scheduledJobForCron,
} from '../app/services/slack-notifications.server'
import { nanoid } from 'nanoid'

export { ArtifactLiveRoom } from './artifact-live-room'
export { D1BackupWorkflow } from './d1-backup-workflow'
export { PostUploadWorkflowSpike } from './post-upload-workflow-spike'

// React Router resolves this virtual module and generates the Wrangler config
// consumed by production deployment; raw wrangler.production.jsonc is build-only.
const requestHandler = createRequestHandler(
  () => import('virtual:react-router/server-build'),
  import.meta.env.MODE,
)

const MAINTENANCE_FLAG_KEY = 'maintenance'

function reconciliationOptionsFromEnv(
  env: Cloudflare.Env,
): ReconciliationOptions {
  const options: ReconciliationOptions = {}
  if (env.STRIPE_SECRET_KEY) {
    const billingEnv = env as BillingEnv
    options.stripe = createStripeClient(billingEnv)
    options.overageProductId = billingEnv.STRIPE_PRODUCT_STORAGE_OVERAGE
  }
  return options
}
const MAINTENANCE_RETRY_AFTER_SECONDS = 300

const MAINTENANCE_HTML = `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Artifact Share - メンテナンス中</title>
<style>
body { font-family: system-ui, sans-serif; line-height: 1.6; margin: 2rem auto; max-width: 36rem; padding: 0 1rem; color: #1a1a1a; }
h1 { font-size: 1.5rem; margin-bottom: 0.5rem; }
</style>
</head>
<body>
<h1>Artifact Share は現在メンテナンス中です</h1>
<p>通常、短時間で復旧します。しばらく時間を置いてからページを再読み込みしてください。</p>
</body>
</html>`

export default {
  scheduled(controller, env, ctx) {
    // createDb() may throw synchronously if env.DB is misbound. Wrap it inside
    // the promise so any failure flows through ctx.waitUntil and surfaces on
    // the dashboard as a failed cron, not a silent success.
    ctx.waitUntil(
      (async () => {
        const db = createDb()
        if (scheduledJobForCron(controller.cron) === 'slack-notifications') {
          await processSlackNotificationOutbox(db, {
            origin: env.BETTER_AUTH_URL,
            now: new Date(controller.scheduledTime),
            claimToken: nanoid(),
          })
          return
        }
        const options = reconciliationOptionsFromEnv(env)
        await runReconciliation(
          db,
          env.BUCKET,
          new Date(controller.scheduledTime),
          options,
        )
      })(),
    )
  },
  async fetch(request, env, ctx) {
    // Lazy initialization (better-auth init, React Router server build) is
    // driven by whichever request touches it first. Anchor both to waitUntil
    // once per isolate so a client abort cannot leave a permanently pending
    // initialization promise that hangs every later request in the isolate.
    anchorAuthInit(ctx)
    anchorServerBuild(ctx)
    const url = new URL(request.url)
    const hostname = requestHostname(request, env)
    const sanitizedRequest = requestWithoutMaintenanceHeader(request)
    let handlerRequest: Request = sanitizedRequest
    if (await isMaintenanceEnabled(env, url, hostname)) {
      if (!isMaintenanceExempt(url)) return maintenanceResponse(url)
      handlerRequest = maintenanceExemptRequest(sanitizedRequest)
    }

    // Dev-only manual reconcile trigger. `wrangler dev --test-scheduled`
    // exposes `/__scheduled` for cron testing, but the Vite-built worker has
    // the RR fetch handler swallowing the path before wrangler can intercept
    // it. This branch lets `curl localhost:8787/__scheduled` fire the same
    // pipeline. Production rejects so leaked routes can't trigger reconciles.
    if (url.pathname === '/__scheduled') {
      if (isProduction(env)) {
        return new Response('not found', { status: 404 })
      }
      ctx.waitUntil(
        (async () => {
          const db = createDb()
          const options = reconciliationOptionsFromEnv(env)
          await runReconciliation(db, env.BUCKET, new Date(), options)
        })(),
      )
      return new Response('reconcile triggered\n', { status: 200 })
    }

    if (url.pathname === '/__workflows/post-upload-spike') {
      if (isProduction(env)) {
        return new Response('not found', { status: 404 })
      }
      if (!env.POST_UPLOAD_WORKFLOW) {
        return Response.json(
          { error: 'POST_UPLOAD_WORKFLOW binding is not configured' },
          { status: 500 },
        )
      }
      return handlePostUploadWorkflowSpike(request, env.POST_UPLOAD_WORKFLOW)
    }

    if (url.pathname === '/__workflows/d1-backup') {
      if (isProduction(env) || !isIntegrationTest(env)) {
        return new Response('not found', { status: 404 })
      }
      if (!env.D1_BACKUP_WORKFLOW) {
        return Response.json(
          { error: 'D1_BACKUP_WORKFLOW binding is not configured' },
          { status: 500 },
        )
      }
      return handleD1BackupWorkflow(request, env.D1_BACKUP_WORKFLOW)
    }

    if (url.pathname === '/__integration/outbound') {
      if (isProduction(env) || !isIntegrationTest(env)) {
        return new Response('not found', { status: 404 })
      }
      return fetch('https://unhandled.example.test/')
    }

    const liveShareableId = liveShareableIdFromPath(url.pathname)
    if (liveShareableId) {
      return handleArtifactLiveRequest(request, env, liveShareableId)
    }

    // Hot path: apex traffic falls straight through to the RR handler. In dev,
    // the Vite/Workers bridge may normalize request.url to localhost while
    // preserving the original *.localhost host header, so resolve through the
    // shared helper before host-based routing.
    if (hostname !== APEX_HOST) {
      if (hostname === WWW_HOST) {
        const wwwRedirect = new URL(request.url)
        wwwRedirect.hostname = APEX_HOST
        return Response.redirect(wwwRedirect.toString(), 301)
      }
    }

    const context = new RouterContextProvider()
    context.set(ctxContext, ctx)
    return requestHandler(handlerRequest, context)
  },
} satisfies ExportedHandler<Cloudflare.Env>

function isIntegrationTest(env: Cloudflare.Env): boolean {
  return (
    (env as Cloudflare.Env & { INTEGRATION_TEST?: string }).INTEGRATION_TEST ===
    'true'
  )
}

let serverBuildAnchored = false

function anchorServerBuild(ctx: ExecutionContext): void {
  if (serverBuildAnchored) return
  serverBuildAnchored = true
  ctx.waitUntil(
    import('virtual:react-router/server-build').then(
      () => {},
      () => {
        // Retry the anchoring next request; the real failure surfaces through
        // requestHandler on routes that need the build.
        serverBuildAnchored = false
      },
    ),
  )
}

function liveShareableIdFromPath(pathname: string): string | null {
  const match = /^\/api\/shareables\/([^/]+)\/live$/.exec(pathname)
  if (!match) return null
  try {
    return decodeURIComponent(match[1] ?? '')
  } catch {
    return null
  }
}

async function handleArtifactLiveRequest(
  request: Request,
  env: Cloudflare.Env,
  shareableId: string,
): Promise<Response> {
  if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
    return new Response('Not Found', { status: 404 })
  }

  const user = await getSessionUser(request)
  if (!user) return new Response('Not Found', { status: 404 })

  const access = await loadCommentAccess(createDb(), user, shareableId)
  if (!access) return new Response('Not Found', { status: 404 })

  const liveUrl = new URL(request.url)
  liveUrl.search = ''
  liveUrl.searchParams.set('user_id', user.id)
  liveUrl.searchParams.set(
    'name',
    boundedLiveParam(user.name, 120) ?? user.email,
  )
  liveUrl.searchParams.set('initial', getOwnerInitial(user.name, user.email))
  const image = boundedLiveParam(user.image, 500)
  if (image) liveUrl.searchParams.set('image', image)

  return env.ARTIFACT_LIVE.getByName(shareableId).fetch(
    new Request(liveUrl, request),
  )
}

function boundedLiveParam(
  value: string | null | undefined,
  maxLength: number,
): string | null {
  const trimmed = value?.trim()
  if (!trimmed || trimmed.length > maxLength) return null
  return trimmed
}

async function isMaintenanceEnabled(
  env: Cloudflare.Env,
  url: URL,
  hostname: string,
): Promise<boolean> {
  const result = await evaluateFlagshipFlag(env, {
    flagKey: MAINTENANCE_FLAG_KEY,
    context: {
      targetingKey: hostname,
      hostname,
      pathname: url.pathname,
    },
  })

  switch (result.kind) {
    case 'evaluated':
      return result.enabled
    case 'missing-binding':
      if (result.production) {
        console.error('maintenance_flagship_binding_missing_in_production')
        return false
      }
      return result.enabled
    case 'evaluation-error':
      console.error('maintenance_flagship_evaluation_failed', result.error)
      return false
  }
}

function isMaintenanceExempt(url: URL): boolean {
  if (isMaintenanceDiscoveryPath(url.pathname)) return true
  if (isMaintenanceOgImagePath(url.pathname)) return true
  if (isMaintenanceStaticAssetPath(url.pathname)) return true
  if (isMaintenancePublicPagePath(url.pathname)) return true
  if (isMaintenancePublicDataRequest(url.pathname)) return true
  if (isMaintenancePublicManifestRequest(url)) return true
  return false
}

function isMaintenanceDiscoveryPath(pathname: string): boolean {
  const normalized = normalizeGuidePathname(pathname)
  return (
    normalized === '/robots.txt' ||
    normalized === '/sitemap.xml' ||
    normalized === '/llms.txt' ||
    normalized === '/.well-known/agent.json' ||
    normalized === '/capabilities.md' ||
    normalized === '/pricing.md' ||
    normalized === '/openapi.json'
  )
}

function isMaintenanceOgImagePath(pathname: string): boolean {
  const normalized = normalizeGuidePathname(pathname)
  return (
    normalized === '/og-image' ||
    normalized === '/connect/og-image' ||
    normalized === '/ja/connect/og-image' ||
    normalized === '/guides/private-mobile-design-handoff/og-image' ||
    normalized === '/ja/guides/private-mobile-design-handoff/og-image'
  )
}

function isMaintenanceStaticAssetPath(pathname: string): boolean {
  const normalized = normalizeGuidePathname(pathname)
  return (
    normalized === '/favicon.ico' ||
    normalized === '/favicon.svg' ||
    normalized === '/apple-touch-icon.png' ||
    normalized.startsWith('/file-types/') ||
    normalized.startsWith('/assets/')
  )
}

function isMaintenancePublicPagePath(pathname: string): boolean {
  return normalizeGuidePathname(pathname) === '/' || isPublicPagePath(pathname)
}

function isMaintenancePublicDataRequest(pathname: string): boolean {
  if (!pathname.endsWith('.data')) return false
  const routePathname =
    pathname === '/_root.data' ? '/' : pathname.slice(0, -'.data'.length)
  return isMaintenancePublicPagePath(routePathname)
}

function isMaintenancePublicManifestRequest(url: URL): boolean {
  if (url.pathname !== '/__manifest') return false
  const paths = url.searchParams.get('paths')
  if (!paths) return false
  const requestedPathnames = paths.split(',').filter(Boolean)
  return (
    requestedPathnames.length > 0 &&
    requestedPathnames.every((pathname) =>
      isMaintenancePublicPagePath(pathname),
    )
  )
}

function maintenanceExemptRequest(request: Request): Request {
  const stripped = requestWithoutAuthCookies(request)
  const headers = new Headers(stripped.headers)
  headers.set(MAINTENANCE_REQUEST_HEADER, '1')
  return new Request(stripped, { headers })
}

function requestWithoutMaintenanceHeader(request: Request): Request {
  if (!request.headers.has(MAINTENANCE_REQUEST_HEADER)) return request
  const headers = new Headers(request.headers)
  headers.delete(MAINTENANCE_REQUEST_HEADER)
  return new Request(request, { headers })
}

function requestWithoutAuthCookies(request: Request): Request {
  const cookie = request.headers.get('cookie')
  if (!cookie) return request
  const kept = cookie
    .split(';')
    .map((part) => part.trim())
    .filter((part) => {
      const name = part.split('=', 1)[0]?.trim()
      return !isAuthCookieName(name)
    })
  if (kept.length === cookie.split(';').length) return request

  const headers = new Headers(request.headers)
  if (kept.length > 0) {
    headers.set('cookie', kept.join('; '))
  } else {
    headers.delete('cookie')
  }
  return new Request(request, { headers })
}

function maintenanceResponse(url: URL): Response {
  if (isMaintenanceCliApiPath(url.pathname)) return maintenanceCliApiResponse()
  if (isMaintenanceMcpPath(url.pathname)) return maintenanceMcpResponse()
  return new Response(MAINTENANCE_HTML, {
    status: 503,
    headers: maintenanceHeaders('text/html; charset=utf-8'),
  })
}

function maintenanceCliApiResponse(): Response {
  return Response.json(
    {
      error: {
        code: 'maintenance',
        message: 'Artifact Share is currently under maintenance.',
      },
    },
    { status: 503, headers: maintenanceHeaders('application/json') },
  )
}

function maintenanceMcpResponse(): Response {
  return Response.json(
    {
      jsonrpc: '2.0',
      id: null,
      error: {
        code: -32000,
        message: 'Artifact Share is currently under maintenance.',
        data: {
          code: 'maintenance',
          retry_after_seconds: MAINTENANCE_RETRY_AFTER_SECONDS,
        },
      },
    },
    { status: 503, headers: maintenanceHeaders('application/json') },
  )
}

function maintenanceHeaders(contentType: string): HeadersInit {
  return {
    'content-type': contentType,
    'cache-control': 'no-store',
    'retry-after': String(MAINTENANCE_RETRY_AFTER_SECONDS),
  }
}

function isMaintenanceCliApiPath(pathname: string): boolean {
  return pathname === '/api/cli' || pathname.startsWith('/api/cli/')
}

function isMaintenanceMcpPath(pathname: string): boolean {
  return pathname === '/mcp' || pathname.startsWith('/mcp/')
}
