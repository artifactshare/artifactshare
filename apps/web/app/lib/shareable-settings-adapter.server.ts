import { env } from 'cloudflare:workers'
import { errorResponse, linkPublishRateLimitedResponse } from '~/lib/api-errors'
import type {
  EditShareableSettingsPayload,
  EditShareableSettingsResult,
  MoveDestination,
  MoveShareableResult,
  OwnedShareableSummary,
} from '~/services/shareables.server'
import { isProduction, shareableUrl } from '~/lib/hosts'

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
      url: shareableUrl(
        requestUrl,
        shareable.id,
        shareable.visibility,
        isProduction(env),
      ),
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
      url: shareableUrl(
        args.requestUrl,
        args.shareableId,
        args.result.visibility,
        isProduction(env),
      ),
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
    case 'bot-home-unavailable':
      return errorResponse(
        'bot-home-unavailable',
        'Bot-owned artifacts have no home destination.',
        400,
      )
    case 'bot-artifact-grant-unsupported':
      return errorResponse(
        'bot-artifact-grant-unsupported',
        'Bots cannot receive artifact-level grants. Share the project with the bot instead.',
        400,
      )
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
    case 'link-publish-rate-limited':
      return linkPublishRateLimitedResponse(result)
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
    case 'bot-home-unavailable':
      return errorResponse(
        'bot-home-unavailable',
        'Bot-owned artifacts have no home destination.',
        400,
      )
  }
}
