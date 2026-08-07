import { errorResponse } from '~/lib/api-errors'
import {
  EDITABLE_VISIBILITIES,
  type EditableVisibility,
} from '~/lib/shareable-types'
import { requireUserApiMiddleware } from '~/middleware/auth'
import { requireUser } from '~/middleware/context'
import { createDb } from '~/services/db.server'
import { commitDialogChanges } from '~/services/shareables.server'
import type { Route } from './+types/api.shareables.$id.save'

export const middleware = [requireUserApiMiddleware]

export function loader() {
  return new Response('Method Not Allowed', { status: 405 })
}

export async function action({ request, params, context }: Route.ActionArgs) {
  if (request.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405 })
  }

  const payload = parseSavePayload(await request.json().catch(() => null))
  if (!payload) {
    return errorResponse('invalid-save-body', 'Invalid save body.', 400)
  }

  const user = requireUser(context)
  const result = await commitDialogChanges(createDb(), user, params.id, payload)
  switch (result.kind) {
    case 'ok':
      return Response.json({
        visibility: result.visibility,
        grants: result.grants,
        link_expires_at: result.linkExpiresAt,
      })
    case 'not-found':
      return errorResponse('forbidden', 'Forbidden.', 403)
    case 'workspace-unavailable':
      return errorResponse(
        'workspace-unavailable',
        'Workspace visibility is unavailable for this account.',
        400,
      )
    case 'too-many-grants':
      return errorResponse(
        'too-many-grants',
        `Add up to ${result.limit} email addresses.`,
        400,
      )
    case 'commit-failed':
      return errorResponse('commit-failed', 'Failed to save changes.', 502)
    case 'link-sharing-plan-required':
      return errorResponse(
        'link-sharing-plan-required',
        'Link sharing requires a Plus or Team plan.',
        402,
      )
    case 'link-sharing-disabled':
      return errorResponse(
        'link-sharing-disabled',
        'Link sharing is disabled for this workspace.',
        403,
      )
    case 'link-expiry-invalid':
      return errorResponse(
        'link-expiry-invalid',
        'The link expiry is invalid for this workspace policy.',
        400,
      )
    default: {
      const _exhaustive: never = result
      return _exhaustive
    }
  }
}

function parseSavePayload(body: unknown): {
  visibility?: EditableVisibility
  linkExpiresAt?: string | null
  addEmails?: string[]
  removeEmails?: string[]
} | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null
  const raw = body as {
    visibility?: unknown
    link_expires_at?: unknown
    addEmails?: unknown
    removeEmails?: unknown
  }

  const visibility = editableVisibility(raw.visibility)
  if (raw.visibility !== undefined && !visibility) return null
  const linkExpiresAt = optionalNullableString(raw.link_expires_at)
  if (linkExpiresAt === undefined && raw.link_expires_at !== undefined) {
    return null
  }
  const addEmails = optionalStringArray(raw.addEmails)
  const removeEmails = optionalStringArray(raw.removeEmails)
  if (addEmails === null || removeEmails === null) return null

  const hasChanges =
    visibility !== undefined ||
    linkExpiresAt !== undefined ||
    (addEmails?.length ?? 0) > 0 ||
    (removeEmails?.length ?? 0) > 0
  if (!hasChanges) return null

  return {
    ...(visibility ? { visibility } : {}),
    ...(linkExpiresAt !== undefined ? { linkExpiresAt } : {}),
    ...(addEmails ? { addEmails } : {}),
    ...(removeEmails ? { removeEmails } : {}),
  }
}

function optionalNullableString(value: unknown): string | null | undefined {
  if (value === undefined || value === null || typeof value === 'string') {
    return value as string | null | undefined
  }
  return undefined
}

function editableVisibility(value: unknown): EditableVisibility | undefined {
  return typeof value === 'string' &&
    EDITABLE_VISIBILITIES.has(value as EditableVisibility)
    ? (value as EditableVisibility)
    : undefined
}

function optionalStringArray(value: unknown): string[] | undefined | null {
  if (value === undefined) return undefined
  if (!Array.isArray(value)) return null
  if (value.some((item) => typeof item !== 'string')) return null
  return value
}
