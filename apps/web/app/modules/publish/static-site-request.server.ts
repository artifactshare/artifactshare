import {
  FormDataParseError,
  MaxFilesExceededError,
  parseFormData,
} from '@remix-run/form-data-parser'
import { ArtifactUploadFormSchema } from '@artifactshare/contract'
import {
  MaxFileSizeExceededError,
  MaxPartsExceededError,
  MaxTotalSizeExceededError,
} from '@remix-run/multipart-parser'
import { errorResponse, rejectWorkspaceUnavailable } from '~/lib/api-errors'
import { isOrgWorkspace } from '~/lib/user'
import {
  MAX_STATIC_SITE_UPLOAD_FILE_BYTES,
  MAX_STATIC_SITE_UPLOAD_FILES,
  MAX_STATIC_SITE_UPLOAD_PARTS,
  MAX_STATIC_SITE_UPLOAD_TOTAL_BYTES,
  staticSiteBundleResponse,
} from '~/lib/static-site-upload-response.server'
import type { Visibility } from '~/lib/shareable-types'
import {
  beginStaticSiteBundleUploadSession,
  beginStaticSiteBundleVersionUploadSession,
  type UploadStaticSiteBundleResult,
} from '~/services/shareables.server'
import type {
  PublishContent,
  StaticSiteContentSessionContext,
  StaticSiteContentSessionResult,
} from './index'

type StaticSiteUploadRejectedResult = Exclude<
  UploadStaticSiteBundleResult,
  { kind: 'ok' }
>

class StaticSiteUploadRejected extends Error {
  constructor(readonly result: StaticSiteUploadRejectedResult) {
    super(result.kind)
    this.name = 'StaticSiteUploadRejected'
  }
}

export function staticSiteRequestContent(
  request: Request,
  options: {
    expectedContainerId: string | null
  },
): Extract<PublishContent, { kind: 'site' }> {
  return {
    kind: 'site',
    session: {
      publish: (context) =>
        context.target.kind === 'update'
          ? publishStaticSiteUpdate(request, context)
          : publishStaticSiteCreate(request, context, options),
    },
  }
}

async function publishStaticSiteUpdate(
  request: Request,
  context: StaticSiteContentSessionContext,
): Promise<StaticSiteContentSessionResult> {
  if (context.target.kind !== 'update') {
    throw new TypeError('Static-site update adapter requires an update target.')
  }

  const begun = await beginStaticSiteBundleVersionUploadSession(
    context.db,
    {
      id: context.user.id,
      email: context.user.email ?? '',
      workspaceId: context.user.workspaceId,
      hd: context.user.hd ?? null,
    },
    context.target.artifactId,
    context.touchArtifactKeyId,
    {
      ...(context.waitUntil ? { waitUntil: context.waitUntil } : {}),
      ...(context.authority ? { authority: context.authority } : {}),
      ...(context.target.expectedVersionId
        ? { expectedCurrentVersionId: context.target.expectedVersionId }
        : {}),
      ...(context.authority?.kind === 'agent'
        ? { agentProfileId: context.authority.agentProfileId }
        : {}),
    },
  )
  if (begun.kind !== 'ok') {
    if (begun.kind === 'not-found') {
      return { kind: 'static-site-session-not-found' }
    }
    return begun
  }
  const { session } = begun

  try {
    await parseFormData(
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
        if (result.kind !== 'ok') throw new StaticSiteUploadRejected(result)
        return null
      },
    )
  } catch (error) {
    await session.abort()
    if (error instanceof StaticSiteUploadRejected) return error.result
    const parseResult = staticSiteParseErrorResult(error)
    if (parseResult) return parseResult
    throw error
  }

  if (session.fileCount === 0) {
    await session.abort()
    return { kind: 'missing-file' }
  }

  const result = await session.commitVersion()
  if (result.kind !== 'ok') return result
  const shareable = await context.db
    .selectFrom('shareables')
    .select('visibility')
    .where('id', '=', context.target.artifactId)
    .executeTakeFirstOrThrow()
  return {
    kind: 'static-site-update-ok',
    result,
    shareUrlVisibility: shareable.visibility,
  }
}

async function publishStaticSiteCreate(
  request: Request,
  context: StaticSiteContentSessionContext,
  options: { expectedContainerId: string | null },
): Promise<StaticSiteContentSessionResult> {
  const begun =
    context.authority?.kind === 'agent'
      ? await beginStaticSiteBundleUploadSession(
          context.db,
          context.user,
          context.containerId,
          context.idempotencyKey,
          { agentProfileId: context.authority.agentProfileId },
        )
      : await beginStaticSiteBundleUploadSession(
          context.db,
          context.user,
          context.containerId,
          context.idempotencyKey,
        )
  if (begun.kind !== 'ok') return begun
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
        if (result.kind !== 'ok') throw new StaticSiteUploadRejected(result)
        return null
      },
    )
  } catch (error) {
    await session.abort()
    if (error instanceof StaticSiteUploadRejected) return error.result
    const parseResult = staticSiteParseErrorResult(error)
    if (parseResult) return parseResult
    throw error
  }

  const parsedVisibility = ArtifactUploadFormSchema.shape.visibility.safeParse(
    form.get('visibility') ?? undefined,
  )
  if (!parsedVisibility.success) {
    await session.abort()
    return { kind: 'invalid-visibility' }
  }
  const visibility = parsedVisibility.data ?? 'private'
  if (
    context.authority?.kind === 'agent' &&
    (visibility === 'private' || visibility === 'link')
  ) {
    await session.abort()
    return { kind: 'static-site-visibility-forbidden' }
  }

  const linkExpiry = parseLinkExpiry(form.get('link_expires_at'))
  if (linkExpiry.kind === 'invalid') {
    await session.abort()
    return { kind: 'link-expiry-invalid' }
  }
  session.setSlackNotify?.(form.get('slack_notify') !== 'false')
  const unavailable = rejectWorkspaceUnavailable(
    visibility,
    isOrgWorkspace(context.user),
  )
  if (unavailable) {
    await session.abort()
    return { kind: 'workspace-unavailable' }
  }
  if (session.fileCount === 0) {
    await session.abort()
    return { kind: 'missing-file' }
  }

  const parsedForm = ArtifactUploadFormSchema.pick({
    grant_email: true,
    container_id: true,
  }).safeParse({
    grant_email: form.getAll('grant_email'),
    container_id: form.get('container_id') ?? undefined,
  })
  if (!parsedForm.success) {
    await session.abort()
    return staticSiteFormContractResult(parsedForm.error)
  }
  const formContainerId = parsedForm.data.container_id || null
  if (formContainerId !== options.expectedContainerId) {
    await session.abort()
    return { kind: 'invalid-container' }
  }

  return await session.commit(
    visibility,
    parsedForm.data.grant_email ?? [],
    linkExpiry.value,
  )
}

function staticSiteFormContractResult(error: {
  issues: readonly { path: readonly PropertyKey[] }[]
}): StaticSiteContentSessionResult {
  if (error.issues.some((issue) => issue.path[0] === 'grant_email')) {
    return { kind: 'invalid-grants' }
  }
  if (error.issues.some((issue) => issue.path[0] === 'container_id')) {
    return { kind: 'invalid-container' }
  }
  return { kind: 'invalid-form-data' }
}

function staticSiteParseErrorResult(
  error: unknown,
): StaticSiteContentSessionResult | null {
  if (error instanceof MaxFilesExceededError) {
    return { kind: 'too-many-files', limit: MAX_STATIC_SITE_UPLOAD_FILES }
  }
  if (
    error instanceof MaxFileSizeExceededError ||
    error instanceof MaxTotalSizeExceededError
  ) {
    return { kind: 'multipart-too-large' }
  }
  if (error instanceof MaxPartsExceededError) {
    return { kind: 'too-many-parts' }
  }
  if (error instanceof FormDataParseError) {
    return { kind: 'invalid-form-data' }
  }
  return null
}

export function staticSitePublishResponse(
  request: Request,
  result: StaticSiteContentSessionResult,
  extraOkFields: {
    visibility?: Visibility
    link_expires_at?: string | null
    created?: boolean
    locale?: string | null
  } = {},
): Response {
  switch (result.kind) {
    case 'static-site-update-ok':
      return staticSiteBundleResponse(request, result.result, {
        ...extraOkFields,
        shareUrlVisibility: result.shareUrlVisibility,
      })
    case 'static-site-session-not-found':
      return errorResponse('not-found', 'Shareable not found.', 404)
    case 'copy-forbidden':
      return errorResponse(
        'copy-forbidden',
        'This artifact is not a static site.',
        403,
      )
    case 'static-site-visibility-forbidden':
      return errorResponse(
        'forbidden',
        'CLI agent scope does not allow this visibility.',
        403,
      )
    case 'invalid-visibility':
      return errorResponse(
        'invalid-visibility',
        'Invalid visibility value.',
        400,
      )
    case 'link-expiry-invalid':
      return errorResponse(
        'link-expiry-invalid',
        'link_expires_at must be a future RFC3339 UTC timestamp or null.',
        400,
      )
    case 'missing-file':
      return errorResponse('missing-file', 'File is required.', 400)
    case 'invalid-grants':
      return errorResponse('invalid-grants', 'Invalid grant emails.', 400)
    case 'multipart-too-large':
      return errorResponse('too-large', 'Upload is larger than 25 MB.', 413)
    case 'too-many-parts':
      return errorResponse('too-many-parts', 'Upload has too many parts.', 400)
    case 'invalid-form-data':
      return errorResponse(
        'invalid-form-data',
        'Invalid upload form data.',
        400,
      )
    default:
      return staticSiteBundleResponse(request, result, extraOkFields)
  }
}

function parseLinkExpiry(
  value: FormDataEntryValue | null,
): { kind: 'ok'; value?: string | null } | { kind: 'invalid' } {
  if (value === null) return { kind: 'ok' }
  if (typeof value !== 'string') return { kind: 'invalid' }
  if (value === 'null') return { kind: 'ok', value: null }
  return value.length > 0 ? { kind: 'ok', value } : { kind: 'invalid' }
}
