import { authHandlerWithHangDetection } from '~/services/auth.server'
import { getSessionUser } from '~/services/auth.server'
import {
  attachAgentBootstrapAuthority,
  clearAgentApprovalProject,
  loadDeviceAuthorizationIntent,
  isAgentDeviceApproval,
  readDeviceAuthorizationIntent,
  revokeSessionToken,
  selectAgentApprovalProject,
  storeDeviceAuthorizationIntent,
} from '~/services/cli-device-authority.server'
import type { Route } from './+types/api.auth.$'

// Tell the browser to drop cookies + localStorage / IndexedDB on sign-out so
// no UI prefs (locale, view mode) or stale auth tokens leak across sessions
// or accounts on a shared browser. Requires HTTPS — a no-op on http:// dev.
const CLEAR_SITE_DATA = '"cookies", "storage"'

function maybeClearSiteData(request: Request, response: Response): Response {
  if (!/\/sign-?out$/i.test(new URL(request.url).pathname)) return response
  const headers = new Headers(response.headers)
  headers.set('Clear-Site-Data', CLEAR_SITE_DATA)
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}

export async function loader({ request }: Route.LoaderArgs) {
  return maybeClearSiteData(
    request,
    await authHandlerWithHangDetection(request),
  )
}

export async function action({ request }: Route.ActionArgs) {
  const path = new URL(request.url).pathname
  if (path.endsWith('/device/code')) return handleDeviceCode(request)
  if (path.endsWith('/device/token')) return handleDeviceToken(request)
  if (path.endsWith('/device/approve')) return handleDeviceApprove(request)
  return maybeClearSiteData(
    request,
    await authHandlerWithHangDetection(request),
  )
}

async function handleDeviceApprove(request: Request): Promise<Response> {
  const payload = await request
    .clone()
    .json()
    .catch(() => null)
  const userCode = readResponseString(payload, 'userCode')
  if (!userCode || !(await isAgentDeviceApproval(userCode))) {
    return authHandlerWithHangDetection(request)
  }
  const projectId = readResponseString(payload, 'project_id')
  const user = await getSessionUser(request)
  if (!user) {
    return Response.json(
      { error: 'unauthorized', error_description: 'Sign in again' },
      { status: 401, headers: { 'Cache-Control': 'no-store' } },
    )
  }
  if (
    !projectId ||
    !(await selectAgentApprovalProject({
      userCode,
      userId: user.id,
      workspaceId: user.workspaceId,
      email: user.email,
      projectId,
    }))
  ) {
    return Response.json(
      { error: 'invalid_request', error_description: 'Select a valid project' },
      { status: 400, headers: { 'Cache-Control': 'no-store' } },
    )
  }
  const response = await authHandlerWithHangDetection(request)
  if (!response.ok) {
    await clearAgentApprovalProject({ userCode, userId: user.id })
  }
  return response
}

async function handleDeviceCode(request: Request): Promise<Response> {
  const payload = await request
    .clone()
    .json()
    .catch(() => null)
  const intent = readDeviceAuthorizationIntent(payload)
  if (
    payload &&
    typeof payload === 'object' &&
    'preset' in payload &&
    !intent
  ) {
    return Response.json(
      { error: 'invalid_request', error_description: 'Invalid preset' },
      { status: 400, headers: { 'Cache-Control': 'no-store' } },
    )
  }
  const response = await authHandlerWithHangDetection(request)
  if (!response.ok || !intent) return response
  const body = await response
    .clone()
    .json()
    .catch(() => null)
  const deviceCode = readResponseString(body, 'device_code')
  if (deviceCode) await storeDeviceAuthorizationIntent(deviceCode, intent)
  return response
}

async function handleDeviceToken(request: Request): Promise<Response> {
  const payload = await request
    .clone()
    .json()
    .catch(() => null)
  const deviceCode = readResponseString(payload, 'device_code')
  const intent = deviceCode
    ? await loadDeviceAuthorizationIntent(deviceCode)
    : null
  const response = await authHandlerWithHangDetection(request)
  if (!response.ok || intent?.preset !== 'agent') return response
  const body = await response
    .clone()
    .json()
    .catch(() => null)
  const accessToken = readResponseString(body, 'access_token')
  const approvedIntent = deviceCode
    ? await loadDeviceAuthorizationIntent(deviceCode)
    : null
  if (
    accessToken &&
    approvedIntent?.preset === 'agent' &&
    (await attachAgentBootstrapAuthority(accessToken, approvedIntent))
  ) {
    return response
  }
  if (accessToken) await revokeSessionToken(accessToken)
  return Response.json(
    {
      error: 'invalid_grant',
      error_description: 'Agent authorization is incomplete',
    },
    { status: 400, headers: { 'Cache-Control': 'no-store' } },
  )
}

function readResponseString(payload: unknown, key: string): string | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return null
  }
  const value = (payload as Record<string, unknown>)[key]
  return typeof value === 'string' ? value : null
}
