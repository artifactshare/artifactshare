export function errorResponse(
  code: string,
  message: string,
  status: number,
  options?: { details?: Record<string, unknown>; headers?: HeadersInit },
): Response {
  return Response.json(
    {
      error: {
        code,
        message,
        ...(options?.details ? { details: options.details } : {}),
      },
    },
    { status, headers: options?.headers },
  )
}

/**
 * Shared failure shape for CLI artifact read / download routes. An artifact the
 * caller may not see resolves to `not-found` so existence never leaks.
 */
export type CliArtifactErrorResult =
  | { kind: 'not-found' }
  | { kind: 'unsupported-kind'; artifactKind: string }
  | { kind: 'source-unavailable' }

export function cliArtifactErrorResponse(
  result: CliArtifactErrorResult,
  unsupportedKindMessage: string,
): Response {
  switch (result.kind) {
    case 'not-found':
      return errorResponse('not-found', 'Artifact not found.', 404)
    case 'unsupported-kind':
      return errorResponse('unsupported-kind', unsupportedKindMessage, 400)
    case 'source-unavailable':
      return errorResponse(
        'source-unavailable',
        'Artifact source is unavailable.',
        409,
      )
  }
}

export function rejectWorkspaceUnavailable(
  visibility: unknown,
  isOrg: boolean,
): Response | null {
  if (visibility === 'workspace' && !isOrg) {
    return errorResponse(
      'workspace-unavailable',
      'Workspace visibility is unavailable for this account.',
      400,
    )
  }
  return null
}

export function quotaExceededResponse(): Response {
  return errorResponse('quota-exceeded', 'Storage quota is exceeded.', 413)
}

export function workspaceAccessRevokedResponse(): Response {
  return errorResponse(
    'workspace-access-revoked',
    'Your access to this workspace has been revoked.',
    403,
  )
}

export function contributorGuardrailResponse(): Response {
  return errorResponse(
    'contributor-limit-exceeded',
    'This workspace cannot add more contributors. Contact the Artifact Share team.',
    403,
  )
}

export function keyConflictResponse(): Response {
  return errorResponse(
    'key-conflict',
    'Another share created this key first. Retry to update it.',
    409,
  )
}

export function uploadNotAllowedResponse(): Response {
  return errorResponse(
    'upload-not-allowed',
    'Uploads are temporarily unavailable. Contact Artifact Share support if you need help.',
    403,
  )
}

export function selfUploadDisabledResponse(): Response {
  return errorResponse(
    'self-upload-disabled',
    'Sign in with Google or Microsoft to upload files.',
    403,
  )
}

export function uploadPolicyUnavailableResponse(): Response {
  return errorResponse(
    'upload-policy-unavailable',
    'Upload permission could not be checked. Try again.',
    503,
  )
}

export async function readErrorTag(res: Response): Promise<string | undefined> {
  const body = (await res.json().catch(() => null)) as {
    error?: string | { code?: string }
  } | null
  if (typeof body?.error === 'string') return body.error
  return body?.error?.code
}

export type UploadShareableErrorCode =
  | 'missing-file'
  | 'too-many-files'
  | 'too-large'
  | 'file-too-large'
  | 'missing-entrypoint'
  | 'invalid-path'
  | 'path-too-long'
  | 'path-too-deep'
  | 'duplicate-path'
  | 'unsupported-type'
  | 'too-many-parts'
  | 'invalid-form-data'
  | 'invalid-grants'
  | 'invalid-container'
  | 'id-exhausted'
  | 'unknown-artifact-kind'
  | 'invalid-artifact-kind'
  | 'quota-exceeded'
  | 'upload-not-allowed'
  | 'self-upload-disabled'
  | 'upload-policy-unavailable'
  | 'workspace-access-revoked'
  | 'contributor-limit-exceeded'
  | 'storage-failed'
  | 'workspace-unavailable'
  | 'link-sharing-plan-required'
  | 'link-sharing-disabled'
  | 'link-expiry-invalid'

export const UPLOAD_SHAREABLE_ERROR_I18N = {
  'missing-file': 'upload.error.missingFile',
  'too-many-files': 'upload.error.tooManyFiles',
  'too-large': 'upload.error.tooLarge',
  'file-too-large': 'upload.error.fileTooLarge',
  'missing-entrypoint': 'upload.error.missingEntrypoint',
  'invalid-path': 'upload.error.invalidPath',
  'path-too-long': 'upload.error.pathTooLong',
  'path-too-deep': 'upload.error.pathTooDeep',
  'duplicate-path': 'upload.error.duplicatePath',
  'unsupported-type': 'upload.error.unsupportedType',
  'too-many-parts': 'upload.error.generic',
  'invalid-form-data': 'upload.error.generic',
  'invalid-grants': 'upload.error.invalidGrants',
  'invalid-container': 'upload.error.invalidContainer',
  'id-exhausted': 'upload.error.generic',
  'unknown-artifact-kind': 'upload.error.generic',
  'invalid-artifact-kind': 'upload.error.generic',
  'quota-exceeded': 'upload.error.quotaExceeded',
  'upload-not-allowed': 'upload.error.uploadNotAllowed',
  'self-upload-disabled': 'upload.error.selfUploadDisabled',
  'upload-policy-unavailable': 'upload.error.uploadPolicyUnavailable',
  'workspace-access-revoked': 'upload.error.workspaceAccessRevoked',
  'contributor-limit-exceeded': 'upload.error.contributorLimitExceeded',
  'storage-failed': 'upload.error.storageFailed',
  'workspace-unavailable': 'upload.error.workspaceUnavailable',
  'link-sharing-plan-required': 'upload.error.linkSharingPlanRequired',
  'link-sharing-disabled': 'upload.error.linkSharingDisabled',
  'link-expiry-invalid': 'upload.error.linkExpiryInvalid',
} as const satisfies Record<UploadShareableErrorCode, string>

export function isUploadShareableErrorCode(
  code: string | undefined,
): code is UploadShareableErrorCode {
  return code !== undefined && code in UPLOAD_SHAREABLE_ERROR_I18N
}

export type ReplaceVersionErrorCode =
  | 'missing-file'
  | 'too-many-files'
  | 'too-large'
  | 'file-too-large'
  | 'missing-entrypoint'
  | 'invalid-path'
  | 'path-too-long'
  | 'path-too-deep'
  | 'duplicate-path'
  | 'unsupported-type'
  | 'too-many-parts'
  | 'invalid-form-data'
  | 'invalid-artifact-kind'
  | 'copy-forbidden'
  | 'upload-not-allowed'
  | 'self-upload-disabled'
  | 'upload-policy-unavailable'
  | 'workspace-access-revoked'
  | 'quota-exceeded'
  | 'storage-failed'
  | 'reauth-required'
  | 'replace-failed-needs-manual-repair'
  | 'version_conflict'

export const REPLACE_VERSION_ERROR_I18N = {
  'missing-file': 'upload.error.missingFile',
  'too-many-files': 'upload.error.tooManyFiles',
  'too-large': 'upload.error.tooLarge',
  'file-too-large': 'upload.error.fileTooLarge',
  'missing-entrypoint': 'upload.error.missingEntrypoint',
  'invalid-path': 'upload.error.invalidPath',
  'path-too-long': 'upload.error.pathTooLong',
  'path-too-deep': 'upload.error.pathTooDeep',
  'duplicate-path': 'upload.error.duplicatePath',
  'unsupported-type': 'upload.error.unsupportedType',
  'too-many-parts': 'upload.error.generic',
  'invalid-form-data': 'upload.error.generic',
  'invalid-artifact-kind': 'upload.error.generic',
  'copy-forbidden': 'upload.error.copyForbidden',
  'upload-not-allowed': 'upload.error.uploadNotAllowed',
  'self-upload-disabled': 'upload.error.selfUploadDisabled',
  'upload-policy-unavailable': 'upload.error.uploadPolicyUnavailable',
  'workspace-access-revoked': 'upload.error.workspaceAccessRevoked',
  'quota-exceeded': 'upload.error.quotaExceeded',
  'storage-failed': 'upload.error.storageFailed',
  'reauth-required': 'reauth.body',
  'replace-failed-needs-manual-repair': 'upload.error.replaceNeedsManualRepair',
  version_conflict: 'upload.error.versionConflict',
} as const satisfies Record<ReplaceVersionErrorCode, string>

export function isReplaceVersionErrorCode(
  code: string | undefined,
): code is ReplaceVersionErrorCode {
  return code !== undefined && code in REPLACE_VERSION_ERROR_I18N
}
