import {
  FormDataParseError,
  MaxFilesExceededError,
  parseFormData,
} from '@remix-run/form-data-parser'
import {
  MaxFileSizeExceededError,
  MaxPartsExceededError,
  MaxTotalSizeExceededError,
} from '@remix-run/multipart-parser'
import { env } from 'cloudflare:workers'
import {
  errorResponse,
  contributorGuardrailResponse,
  keyConflictResponse,
  rejectWorkspaceUnavailable,
  workspaceAccessRevokedResponse,
} from '~/lib/api-errors'
import { MAX_GRANT_EMAILS } from '~/lib/grant-emails'
import {
  EDITABLE_VISIBILITIES,
  type EditableVisibility,
} from '~/lib/shareable-types'
import {
  MAX_STATIC_SITE_UPLOAD_FILE_BYTES,
  MAX_STATIC_SITE_UPLOAD_FILES,
  MAX_STATIC_SITE_UPLOAD_PARTS,
  MAX_STATIC_SITE_UPLOAD_TOTAL_BYTES,
  staticSiteBundleResponse,
  staticSiteParseErrorResponse,
} from '~/lib/static-site-upload-response.server'
import { createVersionFailureResponse } from '~/lib/create-version-response.server'
import { nowIso } from '~/lib/datetime'
import { isOrgWorkspace } from '~/lib/user'
import { runStaticSiteVersionUpload } from '~/lib/static-site-version-upload.server'
import { uploadPermissionFailureResponse } from '~/lib/upload-permission-response.server'
import { checkUploadAccess } from '~/services/upload-access.server'
import { requireUserApiWithBearerMiddleware } from '~/middleware/auth'
import { ctxContext, getCliAuthority, requireUser } from '~/middleware/context'
import * as middlewareContext from '~/middleware/context'
import { recordFirstArtifactPost } from '~/services/first-post-analytics.server'
import { getAnalyticsConsent } from '~/lib/analytics-consent.server'
import { resolveAnalyticsConsent } from '~/lib/analytics-consent'
import {
  normalizeArtifactKey,
  resolveArtifactKey,
  type ResolveArtifactKeyResult,
} from '~/services/artifact-keys.server'
import { createDb } from '~/services/db.server'
import { resolveUploadContainer } from '~/services/projects.server'
import {
  isAgentOwnedArtifact,
  isAgentPublishableDestination,
} from '~/services/agent-scope.server'
import {
  beginStaticSiteBundleUploadSession,
  createVersion,
  uploadShareable,
  type UploadStaticSiteBundleResult,
} from '~/services/shareables.server'
import { slackReauthorizationWarnings } from '~/services/slack-notifications.server'
import type { Kysely } from 'kysely'
import type { DB } from '~/types/db'
import type { CliAuthority } from '~/services/cli-authority.server'
import { buildUpgradeRequest } from '~/services/upgrade-request.server'
import { DEFAULT_LOCALE, isSupportedLocale } from '~/i18n/messages'
import {
  ARTIFACT_KEY_MAX_LENGTH,
  ARTIFACT_UPLOAD_LIMITS,
} from '~/lib/product-contracts'
import type { Route } from './+types/api.shareables.uploads'

export const middleware = [requireUserApiWithBearerMiddleware]

// This is the admission envelope for the legacy multipart endpoint, not the
// static-site product contract. Static-site hints use the narrower limits from
// static-site-upload-response.server before reaching this parser.
export const LEGACY_MULTIPART_UPLOAD_ENVELOPE = {
  maxFiles: 50,
  maxFileBytes: ARTIFACT_UPLOAD_LIMITS.totalBytes,
  maxTotalBytes: ARTIFACT_UPLOAD_LIMITS.totalBytes,
  maxParts: 50 + 3 + MAX_GRANT_EMAILS * 2,
} as const

export async function action({ request, context }: Route.ActionArgs) {
  const user = requireUser(context)
  const ctx = context.get(ctxContext)
  const waitUntil = (promise: Promise<unknown>) => ctx.waitUntil(promise)
  const db = createDb()
  const authority = getCliAuthority(context)

  const searchParams = new URL(request.url).searchParams
  const rawPublishKey = searchParams.get('publish_key')
  let publishKey: string | null = null
  if (rawPublishKey !== null) {
    publishKey = normalizeArtifactKey(rawPublishKey)
    if (publishKey === null) {
      return errorResponse(
        'invalid-key',
        `publish_key must be 1-${ARTIFACT_KEY_MAX_LENGTH} characters after trimming.`,
        400,
      )
    }
  }

  const kindHint = searchParams.get('artifact_kind')
  if (kindHint === 'static_site') {
    return await uploadStaticSiteWithSession(
      db,
      request,
      user,
      publishKey,
      (middlewareContext.authSourceContext &&
        context.get(middlewareContext.authSourceContext)) === 'bearer'
        ? 'cli'
        : 'web',
      waitUntil,
      authority,
    )
  }

  const formResult = await parseUploadFormData(request)
  if (formResult instanceof Response) return formResult
  const form = formResult
  const rawArtifactKind = form.get('artifact_kind')
  if (rawArtifactKind !== null && typeof rawArtifactKind !== 'string') {
    return errorResponse(
      'invalid-artifact-kind',
      'artifact_kind must be a string.',
      400,
    )
  }
  if (typeof rawArtifactKind === 'string') {
    return errorResponse(
      'unknown-artifact-kind',
      `Unknown artifact_kind: ${rawArtifactKind}`,
      400,
    )
  }
  const visibility = parseUploadVisibility(form.get('visibility'))
  if (!visibility) {
    return errorResponse('invalid-visibility', 'Invalid visibility value.', 400)
  }
  const unavailable = rejectWorkspaceUnavailable(
    visibility,
    isOrgWorkspace(user),
  )
  if (unavailable) return unavailable

  const file = form.get('file')
  if (!(file instanceof File)) {
    return errorResponse('missing-file', 'File is required.', 400)
  }

  const initialGrantEmails = parseInitialGrantEmails(form)
  if (!initialGrantEmails) {
    return errorResponse('invalid-grants', 'Invalid grant emails.', 400)
  }

  const containerId = parseUploadContainerId(form.get('container_id'))
  if (containerId === false) {
    return errorResponse(
      'invalid-container',
      'Invalid upload destination.',
      400,
    )
  }
  if (
    authority?.kind === 'agent' &&
    (visibility === 'private' ||
      visibility === 'link' ||
      !(await isAgentPublishableDestination(db, user, authority, containerId)))
  ) {
    return errorResponse(
      'forbidden',
      'CLI agent scope does not allow this upload.',
      403,
    )
  }
  const linkExpiry = parseUploadLinkExpiry(form.get('link_expires_at'))
  if (linkExpiry.kind === 'invalid') {
    return errorResponse(
      'link-expiry-invalid',
      'link_expires_at must be a future RFC3339 UTC timestamp or null.',
      400,
    )
  }
  const slackNotify = form.get('slack_notify') !== 'false'

  const authorized = await resolveAndAuthorizeUpload(
    db,
    user,
    containerId,
    publishKey,
  )
  if (authorized.kind === 'response') return authorized.response

  if (publishKey !== null) {
    const resolution = await resolveArtifactKey(
      db,
      user,
      containerId,
      publishKey,
      'single_file',
    )
    const failure = keyResolutionFailureResponse(resolution)
    if (failure) return failure
    if (resolution.kind === 'update') {
      if (
        authority?.kind === 'agent' &&
        !(await isAgentOwnedArtifact(
          db,
          user,
          authority,
          resolution.shareableId,
        ))
      ) {
        return errorResponse(
          'forbidden',
          'CLI agent scope does not allow this update.',
          403,
        )
      }
      const updated = await createVersion({
        db,
        user,
        shareableId: resolution.shareableId,
        file,
        touchArtifactKeyId: resolution.keyId,
        waitUntil,
      })
      if (updated.kind !== 'ok') {
        if (updated.kind === 'quota-exceeded') {
          return storageQuotaExceededResponse(
            db,
            user,
            authorized.destination.workspaceId,
          )
        }
        return createVersionFailureResponse(updated, keyKindMismatchResponse)
      }
      return Response.json({
        id: resolution.shareableId,
        versionId: updated.versionId,
        artifactKind: updated.artifactKind,
        visibility: resolution.visibility,
        link_expires_at: resolution.linkExpiresAt,
        containerId,
        shareUrl: `${new URL(request.url).origin}/a/${resolution.shareableId}`,
        created: false,
      })
    }
  }

  const result = await uploadShareable(
    db,
    user,
    file,
    visibility,
    initialGrantEmails,
    containerId,
    publishKey,
    {
      ...(authority?.kind === 'agent' && {
        agentProfileId: authority.agentProfileId,
      }),
      ...(linkExpiry.value !== undefined && {
        linkExpiresAt: linkExpiry.value,
      }),
      ...(slackNotify === false && { slackNotify: false }),
    },
  )
  switch (result.kind) {
    case 'ok': {
      const channel: 'web' | 'cli' =
        (middlewareContext.authSourceContext &&
          context.get(middlewareContext.authSourceContext)) === 'bearer'
          ? 'cli'
          : 'web'
      await recordFirstArtifactPost(db, user, {
        channel,
        sendToGa: firstPostShouldSend(request, channel),
        waitUntil,
      })
      return Response.json({
        id: result.id,
        versionId: result.versionId,
        artifactKind: result.artifactKind,
        visibility: result.visibility,
        link_expires_at: result.linkExpiresAt,
        containerId,
        shareUrl: `${new URL(request.url).origin}/a/${result.id}`,
        ...(publishKey !== null ? { created: true } : {}),
        ...(slackReauthorizationWarnings(
          result.slackNotificationSuppressed,
          user.locale,
        )
          ? {
              warnings: slackReauthorizationWarnings(
                result.slackNotificationSuppressed,
                user.locale,
              ),
            }
          : {}),
      })
    }
    case 'unsupported-type':
      return errorResponse(
        'unsupported-type',
        'Only `.html` and `.md` files are supported for now.',
        415,
      )
    case 'invalid-path':
      return errorResponse(
        'invalid-path',
        'File name contains unsupported characters.',
        400,
      )
    case 'too-large':
      return errorResponse('too-large', 'File is larger than 25 MB.', 413)
    case 'storage-failed':
      return errorResponse(
        'storage-failed',
        'Could not save the file. Try again.',
        502,
      )
    case 'quota-exceeded':
      return storageQuotaExceededResponse(
        db,
        user,
        authorized.destination.workspaceId,
      )
    case 'workspace-access-revoked':
      return workspaceAccessRevokedResponse()
    case 'contributor-limit-exceeded':
      return contributorGuardrailResponse()
    case 'workspace-unavailable':
      return errorResponse(
        'workspace-unavailable',
        'Workspace visibility is unavailable for this account.',
        400,
      )
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
    case 'invalid-container':
      return errorResponse(
        'invalid-container',
        'Invalid upload destination.',
        400,
      )
    case 'too-many-grants':
      return errorResponse(
        'invalid-grants',
        `Add up to ${result.limit} email addresses.`,
        400,
      )
    case 'bot-artifact-grant-unsupported':
      return errorResponse(
        'bot-artifact-grant-unsupported',
        'Bots cannot receive artifact-level grants. Share the project with the bot instead.',
        400,
      )
    case 'id-exhausted':
      return errorResponse(
        'id-exhausted',
        'Could not allocate a unique share ID. Please retry.',
        500,
      )
    case 'key-conflict':
      return keyConflictResponse()
    default: {
      const _exhaustive: never = result
      throw new Error(
        `unhandled upload result kind: ${(_exhaustive as { kind: string }).kind}`,
      )
    }
  }
}

async function storageQuotaExceededResponse(
  db: Kysely<DB>,
  user: Parameters<typeof buildUpgradeRequest>[0]['actor'] & {
    locale: string | null
  },
  billingWorkspaceId: string,
): Promise<Response> {
  const workspace = await db
    .selectFrom('workspaces')
    .select('plan')
    .where('id', '=', billingWorkspaceId)
    .executeTakeFirst()
  const observedPlan = workspace?.plan === 'free' ? 'free' : null
  const upgradeRequest = observedPlan
    ? await buildUpgradeRequest({
        db,
        actor: user,
        billingWorkspaceId,
        limitType: 'storage',
        observedPlan,
        locale: isSupportedLocale(user.locale) ? user.locale : DEFAULT_LOCALE,
        appBaseUrl: env.BETTER_AUTH_URL,
      })
    : null
  return errorResponse('quota-exceeded', 'Storage quota exceeded.', 413, {
    ...(upgradeRequest && { details: { upgrade_request: upgradeRequest } }),
    headers: { 'Cache-Control': 'no-store' },
  })
}

class StaticSiteUploadRejected extends Error {
  constructor(readonly result: UploadStaticSiteBundleResult) {
    super(result.kind)
    this.name = 'StaticSiteUploadRejected'
  }
}

async function resolveAndAuthorizeUpload(
  db: Kysely<DB>,
  user: {
    id: string
    email?: string | null
    emailVerified: boolean
    workspaceId: string
    hd?: string | null
  },
  containerId: string | null,
  publishKey: string | null,
): Promise<
  | {
      kind: 'ok'
      destination: {
        containerId: string
        containerKind: 'inbox' | 'project'
        workspaceId: string
        isExternalPosting: boolean
      }
    }
  | { kind: 'response'; response: Response }
> {
  const destination = await resolveUploadContainer(
    db,
    user,
    containerId,
    nowIso(),
  )
  if (destination.kind !== 'ok') {
    return {
      kind: 'response',
      response: errorResponse(
        'invalid-container',
        'Invalid upload destination.',
        400,
      ),
    }
  }
  const permission = await checkUploadAccess(user)
  if (permission.kind !== 'allowed') {
    return {
      kind: 'response',
      response: uploadPermissionFailureResponse(permission),
    }
  }
  if (publishKey !== null && destination.isExternalPosting) {
    return {
      kind: 'response',
      response: errorResponse(
        'invalid-key',
        'publish_key is not supported for cross-workspace posting.',
        400,
      ),
    }
  }
  return { kind: 'ok', destination }
}

// Whether a first-post measurement send may reach Google. Browser posts honor
// the visitor's analytics consent (same gate as the browser analytics); CLI
// posts have no browser consent signal and are measured as first-party account
// actions, so they always send.
function firstPostShouldSend(
  request: Request,
  channel: 'web' | 'cli',
): boolean {
  if (channel !== 'web') return true
  return resolveAnalyticsConsent(
    getAnalyticsConsent(request),
    request.cf?.country as string | undefined,
  ).shouldLoadAnalytics
}

async function uploadStaticSiteWithSession(
  db: Kysely<DB>,
  request: Request,
  user: {
    id: string
    email: string
    emailVerified: boolean
    workspaceId: string
    hd: string | null
    locale: string | null
    kind: 'human' | 'bot'
  },
  publishKey: string | null,
  channel: 'web' | 'cli',
  waitUntil?: (promise: Promise<unknown>) => void,
  authority?: CliAuthority | null,
): Promise<Response> {
  const urlContainerId = new URL(request.url).searchParams.get('container_id')
  const containerId = parseUploadContainerId(urlContainerId)
  if (containerId === false) {
    return errorResponse(
      'invalid-container',
      'Invalid upload destination.',
      400,
    )
  }
  if (
    authority?.kind === 'agent' &&
    !(await isAgentPublishableDestination(db, user, authority, containerId))
  ) {
    return errorResponse(
      'forbidden',
      'CLI agent scope does not allow this upload.',
      403,
    )
  }

  const authorized = await resolveAndAuthorizeUpload(
    db,
    user,
    containerId,
    publishKey,
  )
  if (authorized.kind === 'response') return authorized.response

  if (publishKey !== null) {
    const resolution = await resolveArtifactKey(
      db,
      user,
      containerId,
      publishKey,
      'static_site',
    )
    const failure = keyResolutionFailureResponse(resolution)
    if (failure) return failure
    if (resolution.kind === 'update') {
      if (
        authority?.kind === 'agent' &&
        !(await isAgentOwnedArtifact(
          db,
          user,
          authority,
          resolution.shareableId,
        ))
      ) {
        return errorResponse(
          'forbidden',
          'CLI agent scope does not allow this update.',
          403,
        )
      }
      const response = await runStaticSiteVersionUpload(
        db,
        request,
        user,
        resolution.shareableId,
        {
          touchArtifactKeyId: resolution.keyId,
          extraOkFields: {
            visibility: resolution.visibility,
            link_expires_at: resolution.linkExpiresAt,
            created: false,
          },
          waitUntil,
        },
      )
      return (await hasErrorCode(response, 'quota-exceeded'))
        ? storageQuotaExceededResponse(
            db,
            user,
            authorized.destination.workspaceId,
          )
        : response
    }
  }

  const begun =
    authority?.kind === 'agent'
      ? await beginStaticSiteBundleUploadSession(
          db,
          user,
          containerId,
          publishKey,
          { agentProfileId: authority.agentProfileId },
        )
      : await beginStaticSiteBundleUploadSession(
          db,
          user,
          containerId,
          publishKey,
        )
  if (begun.kind !== 'ok') {
    return staticSiteBundleResponse(request, begun)
  }
  const { session } = begun

  let form: FormData
  try {
    form = await parseFormData(
      request,
      {
        maxFiles: MAX_STATIC_SITE_UPLOAD_FILES,
        maxFileSize: MAX_STATIC_SITE_UPLOAD_FILE_BYTES,
        maxParts: MAX_STATIC_SITE_UPLOAD_PARTS,
        maxTotalSize: MAX_STATIC_SITE_UPLOAD_TOTAL_BYTES,
      },
      async (file) => {
        if (file.fieldName !== 'file') return file
        const result = await session.addFile(file)
        if (result.kind !== 'ok') {
          throw new StaticSiteUploadRejected(result)
        }
        return null
      },
    )
  } catch (error) {
    if (error instanceof StaticSiteUploadRejected) {
      await session.abort()
      return error.result.kind === 'quota-exceeded'
        ? storageQuotaExceededResponse(
            db,
            user,
            authorized.destination.workspaceId,
          )
        : staticSiteBundleResponse(request, error.result)
    }
    const response = staticSiteParseErrorResponse(error)
    if (response) {
      await session.abort()
      return response
    }
    await session.abort()
    throw error
  }

  const visibility = parseUploadVisibility(form.get('visibility'))
  if (!visibility) {
    await session.abort()
    return errorResponse('invalid-visibility', 'Invalid visibility value.', 400)
  }
  if (
    authority?.kind === 'agent' &&
    (visibility === 'private' || visibility === 'link')
  ) {
    await session.abort()
    return errorResponse(
      'forbidden',
      'CLI agent scope does not allow this visibility.',
      403,
    )
  }
  const linkExpiry = parseUploadLinkExpiry(form.get('link_expires_at'))
  if (linkExpiry.kind === 'invalid') {
    await session.abort()
    return errorResponse(
      'link-expiry-invalid',
      'link_expires_at must be a future RFC3339 UTC timestamp or null.',
      400,
    )
  }
  session.setSlackNotify?.(form.get('slack_notify') !== 'false')
  const unavailable = rejectWorkspaceUnavailable(
    visibility,
    isOrgWorkspace(user),
  )
  if (unavailable) {
    await session.abort()
    return unavailable
  }
  if (session.fileCount === 0) {
    await session.abort()
    return errorResponse('missing-file', 'File is required.', 400)
  }

  const initialGrantEmails = parseInitialGrantEmails(form)
  if (!initialGrantEmails) {
    await session.abort()
    return errorResponse('invalid-grants', 'Invalid grant emails.', 400)
  }

  const formContainerId = parseUploadContainerId(form.get('container_id'))
  if (formContainerId === false || formContainerId !== containerId) {
    await session.abort()
    return errorResponse(
      'invalid-container',
      'Invalid upload destination.',
      400,
    )
  }

  const result = await session.commit(
    visibility,
    initialGrantEmails,
    linkExpiry.value,
  )
  if (result.kind === 'ok')
    await recordFirstArtifactPost(db, user, {
      channel,
      sendToGa: firstPostShouldSend(request, channel),
      waitUntil,
    })
  if (result.kind === 'quota-exceeded') {
    return storageQuotaExceededResponse(
      db,
      user,
      authorized.destination.workspaceId,
    )
  }
  return staticSiteBundleResponse(request, result, {
    ...(publishKey !== null ? { created: true } : {}),
    locale: user.locale,
  })
}

async function hasErrorCode(response: Response, code: string) {
  if (response.ok) return false
  const body = (await response
    .clone()
    .json()
    .catch(() => null)) as {
    error?: { code?: string }
  } | null
  return body?.error?.code === code
}

function keyResolutionFailureResponse(
  resolution: ResolveArtifactKeyResult,
): Response | null {
  switch (resolution.kind) {
    case 'create':
    case 'update':
      return null
    case 'invalid-container':
      return errorResponse(
        'invalid-container',
        'Invalid upload destination.',
        400,
      )
    case 'key-target-moved':
      return errorResponse(
        'key-target-moved',
        'The artifact for this key moved to another destination.',
        409,
      )
    case 'key-kind-mismatch':
      return keyKindMismatchResponse()
  }
}

function keyKindMismatchResponse(): Response {
  return errorResponse(
    'key-kind-mismatch',
    'The artifact for this key does not match this input kind.',
    409,
  )
}

async function parseUploadFormData(
  request: Request,
): Promise<FormData | Response> {
  try {
    return await parseFormData(
      request,
      {
        maxFiles: LEGACY_MULTIPART_UPLOAD_ENVELOPE.maxFiles,
        maxFileSize: LEGACY_MULTIPART_UPLOAD_ENVELOPE.maxFileBytes,
        maxParts: LEGACY_MULTIPART_UPLOAD_ENVELOPE.maxParts,
        maxTotalSize: LEGACY_MULTIPART_UPLOAD_ENVELOPE.maxTotalBytes,
      },
      (file) => file,
    )
  } catch (error) {
    const response = uploadParseErrorResponse(error)
    if (response) return response
    throw error
  }
}

function uploadParseErrorResponse(error: unknown): Response | null {
  if (error instanceof MaxFilesExceededError) {
    return errorResponse(
      'too-many-files',
      `Uploads can include at most ${LEGACY_MULTIPART_UPLOAD_ENVELOPE.maxFiles} files.`,
      400,
    )
  }
  if (
    error instanceof MaxFileSizeExceededError ||
    error instanceof MaxTotalSizeExceededError
  ) {
    return errorResponse('too-large', 'Upload is larger than 25 MB.', 413)
  }
  if (error instanceof MaxPartsExceededError) {
    return errorResponse('too-many-parts', 'Upload has too many parts.', 400)
  }
  if (error instanceof FormDataParseError) {
    return errorResponse('invalid-form-data', 'Invalid upload form data.', 400)
  }
  return null
}

function parseUploadVisibility(value: FormDataEntryValue | null) {
  if (value === null) return 'private'
  return typeof value === 'string' &&
    EDITABLE_VISIBILITIES.has(value as EditableVisibility)
    ? (value as EditableVisibility)
    : null
}

function parseUploadLinkExpiry(
  value: FormDataEntryValue | null,
): { kind: 'ok'; value?: string | null } | { kind: 'invalid' } {
  if (value === null) return { kind: 'ok' }
  if (typeof value !== 'string') return { kind: 'invalid' }
  if (value === 'null') return { kind: 'ok', value: null }
  return value.length > 0 ? { kind: 'ok', value } : { kind: 'invalid' }
}

function parseInitialGrantEmails(form: FormData): string[] | null {
  const entries = form.getAll('grant_email')
  const emails: string[] = []
  for (const entry of entries) {
    if (typeof entry !== 'string') return null
    emails.push(entry)
  }
  return emails
}

function parseUploadContainerId(value: FormDataEntryValue | null) {
  if (value === null || value === '') return null
  if (typeof value !== 'string') return false
  return value
}
