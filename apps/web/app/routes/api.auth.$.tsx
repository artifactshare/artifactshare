import { authHandlerWithHangDetection } from '~/services/auth.server'
import { getSessionUser } from '~/services/auth.server'
import {
  attachAgentBootstrapAuthority,
  attachPublisherBootstrapAuthority,
  isPublisherDeviceApproval,
  selectPublisherApprovalClient,
  clearPublisherApprovalClient,
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
  if (/\/device\/(code|token|approve)$/.test(path)) {
    const payload = await readDeviceRequestBody(request)
    if (payload instanceof Response) return payload
    if (path.endsWith('/device/code')) return handleDeviceCode(request, payload)
    if (path.endsWith('/device/token'))
      return handleDeviceToken(request, payload)
    return handleDeviceApprove(request, payload)
  }
  return maybeClearSiteData(
    request,
    await authHandlerWithHangDetection(request),
  )
}

async function readDeviceRequestBody(
  request: Request,
): Promise<Record<string, unknown> | Response> {
  const mediaType = request.headers
    .get('Content-Type')
    ?.split(';')[0]
    .trim()
    .toLowerCase()
  const isJson = /^application\/(?:[a-z0-9.+-]+\+)?json$/.test(mediaType ?? '')
  if (!isJson && mediaType !== 'application/x-www-form-urlencoded') {
    return Response.json(
      {
        error: 'invalid_request',
        error_description: 'Unsupported content type',
      },
      { status: 415, headers: { 'Cache-Control': 'no-store' } },
    )
  }
  try {
    // Match the delegated handler's form decoding, including last-value wins
    // for repeated fields. Never leave a supported body uninspected.
    const payload: unknown = isJson
      ? await request.clone().json()
      : Object.fromEntries(await request.clone().formData())
    if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
      return payload as Record<string, unknown>
    }
  } catch {
    // Malformed bodies must not reach the delegated handler either.
  }
  return Response.json(
    { error: 'invalid_request', error_description: 'Invalid request body' },
    { status: 400, headers: { 'Cache-Control': 'no-store' } },
  )
}

async function handleDeviceApprove(
  request: Request,
  payload: Record<string, unknown>,
): Promise<Response> {
  const userCode = readResponseString(payload, 'userCode')
  if (userCode && (await isPublisherDeviceApproval(userCode))) {
    const approval = payload
    const user = await getSessionUser(request)
    if (!user) return Response.json({ error: 'unauthorized' }, { status: 401 })
    if (approval.project_id !== undefined)
      return Response.json({ error: 'invalid_request' }, { status: 400 })
    if (
      !(await selectPublisherApprovalClient({
        userCode,
        userId: user.id,
        workspaceId: user.workspaceId,
        choice: approval.publisher,
      }))
    ) {
      return Response.json(
        {
          error: 'invalid_request',
          error_description:
            'Select an owned client, or request a different device_name to create a new client. Existing names must be continued.',
        },
        { status: 400 },
      )
    }
    try {
      const response = await authHandlerWithHangDetection(request)
      if (!response.ok) await clearPublisherApprovalClient(userCode, user.id)
      return response
    } catch (error) {
      await clearPublisherApprovalClient(userCode, user.id)
      throw error
    }
  }
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

async function handleDeviceCode(
  request: Request,
  payload: Record<string, unknown>,
): Promise<Response> {
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

async function handleDeviceToken(
  request: Request,
  payload: Record<string, unknown>,
): Promise<Response> {
  const deviceCode = readResponseString(payload, 'device_code')
  const intent = deviceCode
    ? await loadDeviceAuthorizationIntent(deviceCode)
    : null
  const response = await authHandlerWithHangDetection(request)
  if (!response.ok || !intent) return response
  const body = await response
    .clone()
    .json()
    .catch(() => null)
  const accessToken = readResponseString(body, 'access_token')
  switch (intent.preset) {
    case 'unrestricted':
      return response
    case 'publisher':
      try {
        if (
          accessToken &&
          (await attachPublisherBootstrapAuthority(accessToken, intent))
        )
          return response
      } catch {
        /* Revoke the unscoped token below on attachment failure. */
      }
      break
    case 'agent':
      if (
        accessToken &&
        (await attachAgentBootstrapAuthority(accessToken, intent))
      ) {
        return response
      }
      break
    default: {
      const unexpected: never = intent.preset
      void unexpected
      break
    }
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
