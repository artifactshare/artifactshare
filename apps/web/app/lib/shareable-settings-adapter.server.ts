import { errorResponse } from '~/lib/api-errors'
import type {
  EditShareableSettingsPayload,
  EditShareableSettingsResult,
  MoveDestination,
  MoveShareableResult,
  OwnedShareableSummary,
} from '~/services/shareables.server'

export function parseCliEditPayload(
  value: unknown,
): EditShareableSettingsPayload | null {
  if (!isRecord(value)) return null

  const payload: EditShareableSettingsPayload = {}
  let hasChange = false

  if ('title' in value) {
    if (typeof value.title !== 'string') return null
    payload.title = value.title
    hasChange = true
  }

  if ('visibility' in value) {
    if (
      value.visibility !== 'private' &&
      value.visibility !== 'workspace' &&
      value.visibility !== 'link'
    ) {
      return null
    }
    payload.visibility = value.visibility
    hasChange = true
  }

  if ('link_expires_at' in value) {
    if (
      value.link_expires_at !== null &&
      typeof value.link_expires_at !== 'string'
    ) {
      return null
    }
    payload.linkExpiresAt = value.link_expires_at
    hasChange = true
  }

  if ('add_emails' in value) {
    if (!isStringArray(value.add_emails)) return null
    payload.addEmails = value.add_emails
    hasChange = true
  }

  if ('remove_emails' in value) {
    if (!isStringArray(value.remove_emails)) return null
    payload.removeEmails = value.remove_emails
    hasChange = true
  }

  if ('destination' in value) {
    const destination = parseCliDestination(value.destination, {
      trimProjectId: true,
    })
    if (!destination) return null
    payload.destination = destination
    hasChange = true
  }

  return hasChange ? payload : null
}

export function parseCliDestination(
  value: unknown,
  opts: { trimProjectId?: boolean } = {},
): MoveDestination | null {
  if (value === 'home') return { type: 'inbox' }
  if (
    isRecord(value) &&
    typeof value.project_id === 'string' &&
    value.project_id.length > 0
  ) {
    const projectId = opts.trimProjectId
      ? value.project_id.trim()
      : value.project_id
    if (projectId.length === 0) return null
    return { type: 'project', projectId }
  }
  return null
}

export function payloadFromMcpEditArgs(args: {
  project_id?: string
  title?: string
  visibility?: 'workspace' | 'private' | 'link'
  link_expires_at?: string | null
  add_emails?: string[]
  remove_emails?: string[]
}): EditShareableSettingsPayload {
  const projectId = args.project_id?.trim()
  return {
    ...(args.project_id !== undefined
      ? {
          destination: projectId
            ? { type: 'project', projectId }
            : { type: 'inbox' },
        }
      : {}),
    ...(args.title !== undefined ? { title: args.title } : {}),
    visibility: args.visibility,
    ...(args.link_expires_at !== undefined
      ? { linkExpiresAt: args.link_expires_at }
      : {}),
    addEmails: args.add_emails,
    removeEmails: args.remove_emails,
  }
}

export function cliEditSuccessBody(
  requestUrl: string,
  shareable: OwnedShareableSummary,
) {
  return {
    artifact: {
      id: shareable.id,
      url: new URL(`/a/${shareable.id}`, requestUrl).toString(),
    },
    title: shareable.title,
    destination: shareable.projectId
      ? { type: 'project' as const, project_id: shareable.projectId }
      : { type: 'home' as const, project_id: null },
    share: {
      visibility: shareable.visibility,
      link_expires_at: shareable.linkExpiresAt,
    },
  }
}

export function cliMoveSuccessBody(args: {
  requestUrl: string
  shareableId: string
  destination: MoveDestination
  result: Extract<MoveShareableResult, { kind: 'ok' }>
}) {
  return {
    artifact: {
      id: args.shareableId,
      url: new URL(`/a/${args.shareableId}`, args.requestUrl).toString(),
    },
    destination:
      args.destination.type === 'inbox'
        ? { type: 'home' as const, project_id: null }
        : { type: 'project' as const, project_id: args.result.containerId },
    share: {
      visibility: args.result.visibility,
      project_audience_may_change: args.result.projectAudienceMayChange,
    },
  }
}

export function cliEditErrorResponse(
  result: Exclude<EditShareableSettingsResult, { kind: 'ok' }>,
): Response {
  switch (result.kind) {
    case 'not-found':
      return errorResponse('not-found', 'Shareable not found.', 404)
    case 'invalid-destination':
      return errorResponse('invalid-destination', 'Invalid destination.', 400)
    case 'workspace-unavailable':
      return errorResponse(
        'workspace-unavailable',
        'Workspace visibility is unavailable for this account.',
        400,
      )
    case 'too-many-grants':
      return errorResponse(
        'too-many-grants',
        `Share with at most ${result.limit} email addresses.`,
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
  }
}

export function cliMoveErrorResponse(
  result: Exclude<MoveShareableResult, { kind: 'ok' }>,
): Response {
  switch (result.kind) {
    case 'not-found':
      return errorResponse('not-found', 'Shareable not found.', 404)
    case 'invalid-destination':
      return errorResponse('invalid-destination', 'Invalid destination.', 400)
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
}
