import {
  FormDataParseError,
  MaxFilesExceededError,
} from '@remix-run/form-data-parser'
import {
  MaxFileSizeExceededError,
  MaxPartsExceededError,
  MaxTotalSizeExceededError,
} from '@remix-run/multipart-parser'
import type { Visibility } from '~/lib/shareable-types'
import type {
  UpdateStaticSiteBundleResult,
  UploadStaticSiteBundleResult,
} from '~/services/shareables.server'
import {
  errorResponse,
  contributorGuardrailResponse,
  keyConflictResponse,
  workspaceAccessRevokedResponse,
} from './api-errors'
import { MAX_GRANT_EMAILS } from './grant-emails'
import { STATIC_SITE_UPLOAD_LIMITS } from './upload-artifact-validation'

export const MAX_STATIC_SITE_UPLOAD_FILES = STATIC_SITE_UPLOAD_LIMITS.files
export const MAX_STATIC_SITE_UPLOAD_FILE_BYTES =
  STATIC_SITE_UPLOAD_LIMITS.fileBytes
export const MAX_STATIC_SITE_UPLOAD_TOTAL_BYTES =
  STATIC_SITE_UPLOAD_LIMITS.totalBytes
export const MAX_STATIC_SITE_UPLOAD_PARTS =
  MAX_STATIC_SITE_UPLOAD_FILES + 3 + MAX_GRANT_EMAILS * 2

export function staticSiteBundleResponse(
  request: Request,
  result: UploadStaticSiteBundleResult | UpdateStaticSiteBundleResult,
  extraOkFields: {
    visibility?: Visibility
    link_expires_at?: string | null
    created?: boolean
  } = {},
): Response {
  switch (result.kind) {
    case 'ok':
      return Response.json({
        id: result.id,
        versionId: result.versionId,
        artifactKind: 'static_site',
        ...('visibility' in result ? { visibility: result.visibility } : {}),
        ...('linkExpiresAt' in result
          ? { link_expires_at: result.linkExpiresAt }
          : {}),
        shareUrl: `${new URL(request.url).origin}/a/${result.id}`,
        ...extraOkFields,
      })
    case 'too-many-files':
      return errorResponse(
        'too-many-files',
        `Static sites can include at most ${result.limit} files.`,
        400,
      )
    case 'too-large':
      return errorResponse(
        'too-large',
        'Static site bundle is larger than 25 MB.',
        413,
      )
    case 'file-too-large':
      return errorResponse(
        'file-too-large',
        `File is larger than 10 MB: ${result.path}`,
        413,
      )
    case 'missing-entrypoint':
      return errorResponse(
        'missing-entrypoint',
        'Static site bundle must include /index.html or /index.md.',
        400,
      )
    case 'invalid-path':
      return errorResponse(
        'invalid-path',
        `Invalid static site path ${result.path}: ${result.reason}`,
        400,
      )
    case 'path-too-long':
      return errorResponse(
        'path-too-long',
        `Static site path is longer than ${result.limitChars} characters: ${result.path}`,
        400,
      )
    case 'path-too-deep':
      return errorResponse(
        'path-too-deep',
        `Static site path exceeds ${result.limitDepth} folders: ${result.path}`,
        400,
      )
    case 'duplicate-path':
      return errorResponse(
        'duplicate-path',
        `Static site bundle contains a duplicate path: ${result.path}`,
        400,
      )
    case 'unsupported-type':
      return errorResponse(
        'unsupported-type',
        `Static site bundle contains an unsupported file type: ${result.path}`,
        415,
      )
    case 'quota-exceeded':
      return errorResponse('quota-exceeded', 'Storage quota exceeded.', 413)
    case 'workspace-access-revoked':
      return workspaceAccessRevokedResponse()
    case 'contributor-limit-exceeded':
      return contributorGuardrailResponse()
    case 'storage-failed':
      return errorResponse(
        'storage-failed',
        'Could not save the files. Try again.',
        502,
      )
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
        `unhandled static site upload result kind: ${(_exhaustive as { kind: string }).kind}`,
      )
    }
  }
}

export function staticSiteParseErrorResponse(error: unknown): Response | null {
  if (error instanceof MaxFilesExceededError) {
    return errorResponse(
      'too-many-files',
      `Static sites can include at most ${MAX_STATIC_SITE_UPLOAD_FILES} files.`,
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
