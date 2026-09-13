import {
  FormDataParseError,
  MaxFilesExceededError,
  parseFormData,
} from '@remix-run/form-data-parser'
import {
  ArtifactUploadFormSchema,
  ArtifactUploadQuerySchema,
  ArtifactUploadResponseSchema,
} from '@artifactshare/contract'
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
  linkPublishRateLimitedResponse,
} from '~/lib/api-errors'
import { MAX_GRANT_EMAILS } from '~/lib/grant-emails'
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
import { isProduction, shareableUrl } from '~/lib/hosts'
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
import { isAgentPublishableDestination } from '~/services/agent-scope.server'
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
const LEGACY_MULTIPART_MAX_FILES = 50
export const LEGACY_MULTIPART_UPLOAD_ENVELOPE = {
  maxFiles: LEGACY_MULTIPART_MAX_FILES,
  maxFileBytes: ARTIFACT_UPLOAD_LIMITS.totalBytes,
  maxTotalBytes: ARTIFACT_UPLOAD_LIMITS.totalBytes,
  maxParts: LEGACY_MULTIPART_MAX_FILES + 3 + MAX_GRANT_EMAILS * 2,
} as const

export async function action({ request, context }: Route.ActionArgs) {
  const user = requireUser(context)
  const ctx = context.get(ctxContext)
  const waitUntil = (promise: Promise<unknown>) => ctx.waitUntil(promise)
  const db = createDb()
  const authority = getCliAuthority(context)

  const searchParams = new URL(request.url).searchParams
  const rawPublishKey = searchParams.get('publish_key')
  const rawExpectedVersion = searchParams.get('expected_version')
  const rawKindHint = searchParams.get('artifact_kind')
  const parsedQuery = ArtifactUploadQuerySchema.safeParse({
    publish_key: rawPublishKey ?? undefined,
    expected_version: rawExpectedVersion ?? undefined,
    // Unknown hints historically fell through to the single-file path. Keep
    // that compatibility while asserting all recognized query fields through
    // the shared contract.
    ...(rawKindHint === null || rawKindHint === 'static_site'
      ? { artifact_kind: rawKindHint ?? undefined }
      : {}),
    container_id: searchParams.get('container_id') ?? undefined,
  })
  if (!parsedQuery.success) {
    return errorResponse('validation-failed', 'Invalid upload query.', 400)
  }
  const expectedCurrentVersionId =
    parsedQuery.data.expected_version?.trim() || null
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

  const kindHint = parsedQuery.data.artifact_kind
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
      expectedCurrentVersionId,
      parsedQuery.data.container_id,
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
  const parsedForm = ArtifactUploadFormSchema.safeParse({
    file: form.getAll('file'),
    visibility: form.get('visibility') ?? undefined,
    grant_email:
      form.getAll('grant_email').length > 0
        ? form.getAll('grant_email')
        : undefined,
    container_id: form.get('container_id') ?? undefined,
    link_expires_at: form.get('link_expires_at') ?? undefined,
    slack_notify: form.get('slack_notify') ?? undefined,
  })
  if (!parsedForm.success) {
    return uploadFormContractError(parsedForm.error, 'single')
  }
  const visibility = parsedForm.data.visibility ?? 'private'
  const unavailable = rejectWorkspaceUnavailable(
    visibility,
    isOrgWorkspace(user),
  )
  if (unavailable) return unavailable

  const file = form.get('file')
  if (!(file instanceof File)) {
    return errorResponse('missing-file', 'File is required.', 400)
  }

  const initialGrantEmails = parsedForm.data.grant_email ?? []

  const containerId = parseUploadContainerId(parsedForm.data.container_id)
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
  const linkExpiry = parseUploadLinkExpiry(
    parsedForm.data.link_expires_at ?? null,
  )
  if (linkExpiry.kind === 'invalid') {
    return errorResponse(
      'link-expiry-invalid',
      'link_expires_at must be a future RFC3339 UTC timestamp or null.',
      400,
    )
  }
  const slackNotify = parsedForm.data.slack_notify !== 'false'

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
      if (authority?.kind === 'agent' && !expectedCurrentVersionId) {
        return errorResponse(
          'expected-version-required',
          'Agent updates require the current version id.',
          400,
        )
      }
      const updated = await createVersion({
        db,
        user,
        shareableId: resolution.shareableId,
        file,
        touchArtifactKeyId: resolution.keyId,
        waitUntil,
        authority,
        expectedCurrentVersionId: expectedCurrentVersionId ?? undefined,
        agentProfileId:
          authority?.kind === 'agent' ? authority.agentProfileId : null,
      })
      if (updated.kind !== 'ok') {
        if (updated.kind === 'version-conflict') {
          return Response.json(
            {
              error: {
                code: 'version_conflict',
                message:
                  'The artifact changed before the update was committed.',
                details: {
                  current_version_id: updated.currentVersionId,
                },
              },
            },
            { status: 409 },
          )
        }
        if (updated.kind === 'quota-exceeded') {
          return storageQuotaExceededResponse(
            db,
            user,
            authorized.destination.workspaceId,
          )
        }
        return createVersionFailureResponse(updated, keyKindMismatchResponse)
      }
      return Response.json(
        ArtifactUploadResponseSchema.parse({
          id: resolution.shareableId,
          versionId: updated.versionId,
          artifactKind: updated.artifactKind,
          visibility: resolution.visibility,
          link_expires_at: resolution.linkExpiresAt,
          containerId,
          shareUrl: shareableUrl(
            new URL(request.url).origin,
            resolution.shareableId,
            resolution.visibility,
            isProduction(env),
          ),
          created: false,
        }),
      )
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
      return Response.json(
        ArtifactUploadResponseSchema.parse({
          id: result.id,
          versionId: result.versionId,
          artifactKind: result.artifactKind,
          visibility: result.visibility,
          link_expires_at: result.linkExpiresAt,
          containerId,
          shareUrl: shareableUrl(
            new URL(request.url).origin,
            result.id,
            result.visibility,
            isProduction(env),
          ),
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
        }),
      )
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
    case 'link-publish-rate-limited':
      return linkPublishRateLimitedResponse(result)
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
    selfUploadEnabled?: boolean
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
  expectedCurrentVersionId?: string | null,
  queryContainerId?: string,
): Promise<Response> {
  const containerId = parseUploadContainerId(queryContainerId)
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
      if (authority?.kind === 'agent' && !expectedCurrentVersionId) {
        return errorResponse(
          'expected-version-required',
          'Agent updates require the current version id.',
          400,
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
          ...(authority ? { authority } : {}),
          ...(expectedCurrentVersionId ? { expectedCurrentVersionId } : {}),
          ...(authority?.kind === 'agent'
            ? { agentProfileId: authority.agentProfileId }
            : {}),
        },
      )
      if (await hasErrorCode(response, 'quota-exceeded')) {
        return storageQuotaExceededResponse(
          db,
          user,
          authorized.destination.workspaceId,
        )
      }
      return contractUploadResponse(response)
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

  const parsedForm = ArtifactUploadFormSchema.partial().safeParse({
    visibility: form.get('visibility') ?? undefined,
    grant_email:
      form.getAll('grant_email').length > 0
        ? form.getAll('grant_email')
        : undefined,
    container_id: form.get('container_id') ?? undefined,
    link_expires_at: form.get('link_expires_at') ?? undefined,
    slack_notify: form.get('slack_notify') ?? undefined,
  })
  if (!parsedForm.success) {
    await session.abort()
    return uploadFormContractError(parsedForm.error, 'static')
  }
  const visibility = parsedForm.data.visibility ?? 'private'
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
  const linkExpiry = parseUploadLinkExpiry(
    parsedForm.data.link_expires_at ?? null,
  )
  if (linkExpiry.kind === 'invalid') {
    await session.abort()
    return errorResponse(
      'link-expiry-invalid',
      'link_expires_at must be a future RFC3339 UTC timestamp or null.',
      400,
    )
  }
  session.setSlackNotify?.(parsedForm.data.slack_notify !== 'false')
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

  const initialGrantEmails = parsedForm.data.grant_email ?? []

  const formContainerId = parseUploadContainerId(parsedForm.data.container_id)
  if (formContainerId !== containerId) {
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
  return contractUploadResponse(
    staticSiteBundleResponse(request, result, {
      ...(publishKey !== null ? { created: true } : {}),
      locale: user.locale,
    }),
  )
}

async function contractUploadResponse(response: Response): Promise<Response> {
  if (!response.ok) return response
  const body = ArtifactUploadResponseSchema.parse(await response.json())
  return new Response(JSON.stringify(body), {
    status: response.status,
    headers: response.headers,
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

function uploadFormContractError(
  error: {
    issues: readonly { path: readonly PropertyKey[] }[]
  },
  mode: 'single' | 'static',
): Response {
  const hasIssue = (field: string) =>
    error.issues.some((issue) => issue.path[0] === field)
  const fields =
    mode === 'single'
      ? [
          'visibility',
          'file',
          'grant_email',
          'container_id',
          'link_expires_at',
          'slack_notify',
        ]
      : [
          'visibility',
          'link_expires_at',
          'grant_email',
          'container_id',
          'slack_notify',
        ]
  for (const field of fields) {
    if (!hasIssue(field)) continue
    switch (field) {
      case 'visibility':
        return errorResponse(
          'invalid-visibility',
          'Invalid visibility value.',
          400,
        )
      case 'file':
        return errorResponse('missing-file', 'File is required.', 400)
      case 'grant_email':
        return errorResponse('invalid-grants', 'Invalid grant emails.', 400)
      case 'container_id':
        return errorResponse(
          'invalid-container',
          'Invalid upload destination.',
          400,
        )
      case 'link_expires_at':
        return errorResponse(
          'link-expiry-invalid',
          'link_expires_at must be a future RFC3339 UTC timestamp or null.',
          400,
        )
      case 'slack_notify':
        return errorResponse(
          'invalid-form-data',
          'Invalid upload form data.',
          400,
        )
    }
  }
  return errorResponse('invalid-form-data', 'Invalid upload form data.', 400)
}

function parseUploadLinkExpiry(
  value: FormDataEntryValue | null,
): { kind: 'ok'; value?: string | null } | { kind: 'invalid' } {
  if (value === null) return { kind: 'ok' }
  if (typeof value !== 'string') return { kind: 'invalid' }
  if (value === 'null') return { kind: 'ok', value: null }
  return value.length > 0 ? { kind: 'ok', value } : { kind: 'invalid' }
}

function parseUploadContainerId(
  value: string | null | undefined,
): string | null {
  return value === null || value === undefined || value === '' ? null : value
}
