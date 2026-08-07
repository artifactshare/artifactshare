import { errorResponse, rejectWorkspaceUnavailable } from '~/lib/api-errors'
import { isOrgWorkspace } from '~/lib/user'
import {
  EDITABLE_VISIBILITIES,
  type EditableVisibility,
} from '~/lib/shareable-types'
import { requireUserApiMiddleware } from '~/middleware/auth'
import { requireUser } from '~/middleware/context'
import { createDb } from '~/services/db.server'
import { updateShareableMetadata } from '~/services/shareables.server'
import type { Route } from './+types/api.shareables.$id'

export const middleware = [requireUserApiMiddleware]

export function action({ request, params, context }: Route.ActionArgs) {
  if (request.method === 'PATCH') return patchAction(request, params, context)
  return new Response('Method Not Allowed', { status: 405 })
}

async function patchAction(
  request: Request,
  params: Route.ActionArgs['params'],
  context: Route.ActionArgs['context'],
) {
  const user = requireUser(context)
  const body = (await request.json().catch(() => null)) as {
    visibility?: unknown
    link_expires_at?: unknown
    titleOverride?: unknown
  } | null
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return errorResponse('invalid-patch', 'Invalid patch body.', 400)
  }
  const keys = Object.keys(body)
  if (
    keys.length === 0 ||
    keys.some(
      (key) =>
        key !== 'visibility' &&
        key !== 'link_expires_at' &&
        key !== 'titleOverride',
    )
  ) {
    return errorResponse('invalid-patch', 'Invalid patch body.', 400)
  }

  const hasVisibility = Object.hasOwn(body, 'visibility')
  const hasTitleOverride = Object.hasOwn(body, 'titleOverride')
  const hasLinkExpiresAt = Object.hasOwn(body, 'link_expires_at')
  const linkExpiresAt = hasLinkExpiresAt
    ? parseLinkExpiresAt(body.link_expires_at)
    : undefined
  if (hasLinkExpiresAt && linkExpiresAt === undefined) {
    return errorResponse(
      'link-expiry-invalid',
      'link_expires_at must be an RFC3339 UTC timestamp or null.',
      400,
    )
  }
  const visibility = hasVisibility
    ? parseVisibility(body.visibility)
    : undefined
  if (hasVisibility && visibility === null) {
    return errorResponse('invalid-visibility', 'Invalid visibility value.', 400)
  }
  if (visibility !== undefined && visibility !== null) {
    const unavailable = rejectWorkspaceUnavailable(
      visibility,
      isOrgWorkspace(user),
    )
    if (unavailable) return unavailable
  }

  const titleOverride = hasTitleOverride
    ? parseTitleOverride(body.titleOverride)
    : undefined
  if (hasTitleOverride && titleOverride === undefined) {
    return errorResponse(
      'invalid-title-override',
      'Invalid title override.',
      400,
    )
  }
  if (
    titleOverride !== undefined &&
    titleOverride !== null &&
    titleOverride.length > 200
  ) {
    return errorResponse('title-too-long', 'Title override is too long.', 400)
  }

  const db = createDb()
  const result = await updateShareableMetadata(db, user, params.id, {
    visibility: visibility ?? undefined,
    linkExpiresAt: hasLinkExpiresAt ? (linkExpiresAt ?? null) : undefined,
    titleOverride: hasTitleOverride ? (titleOverride ?? null) : undefined,
  })
  if (result.kind === 'not-found') {
    return errorResponse('not-found', 'Shareable not found.', 404)
  }
  if (result.kind === 'link-sharing-plan-required') {
    return errorResponse(
      'link-sharing-plan-required',
      'Link sharing requires a Plus or Team plan.',
      402,
    )
  }
  if (result.kind === 'link-sharing-disabled') {
    return errorResponse(
      'link-sharing-disabled',
      'Link sharing is disabled for this workspace.',
      403,
    )
  }
  if (result.kind === 'link-expiry-invalid') {
    return errorResponse(
      'link-expiry-invalid',
      'The link expiry is invalid for this workspace policy.',
      400,
    )
  }

  return Response.json({
    id: params.id,
    link_expires_at: result.linkExpiresAt ?? null,
    ...(visibility !== undefined ? { visibility } : {}),
    ...(hasTitleOverride ? { titleOverride: titleOverride ?? null } : {}),
  })
}

function parseLinkExpiresAt(value: unknown): string | null | undefined {
  if (value === null || typeof value === 'string') return value
  return undefined
}

function parseVisibility(value: unknown): EditableVisibility | null {
  return typeof value === 'string' &&
    EDITABLE_VISIBILITIES.has(value as EditableVisibility)
    ? (value as EditableVisibility)
    : null
}

function parseTitleOverride(value: unknown): string | null | undefined {
  if (value === null) return null
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed === '' ? null : trimmed
}
