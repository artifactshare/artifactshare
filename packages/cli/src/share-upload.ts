import type { FormData } from 'undici'
import { ARTIFACT_UPLOAD_RESPONSE_SCHEMA } from '@artifactshare/contract'
import type { ApiErrorOptions, CliError, FetchInit } from './types.js'
import { cliFetch, readJson } from './api.js'
import { mapApiError, networkError } from './errors.js'
import { isContract, isRecord } from './validators.js'

export interface ShareUploadArgs {
  uploadUrl: URL
  token: string
  form: FormData
  requestInit: FetchInit
  errorOptions: ApiErrorOptions
}

export interface ShareUploadBody {
  id: string | null
  url: string | null
  versionId: string | null
  artifactKind: string | null
  visibility: string | null
  linkExpiresAt: string | null
  created: boolean
  warnings: { code: 'slack_reauthorization_required'; message: string }[]
}

/** Perform the upload POST shared by `share` and the preview share dialog.
 * Auth retry stays with the callers; this maps transport and API errors
 * into a typed result. */
export async function postShareUpload(
  args: ShareUploadArgs,
  baseUrl: string,
  fallbackKind: string,
): Promise<{ body: ShareUploadBody } | { error: CliError }> {
  const response = await cliFetch(args.uploadUrl, {
    method: 'POST',
    headers: { Authorization: `Bearer ${args.token}` },
    body: args.form,
    ...args.requestInit,
  } as FetchInit)
  if ('networkError' in response) {
    return { error: networkError(response.networkError) }
  }
  const body = await readJson(response)
  if (!response.ok) {
    return { error: mapApiError(response.status, body, args.errorOptions) }
  }
  const contractBody = isContract(ARTIFACT_UPLOAD_RESPONSE_SCHEMA, body)
    ? body
    : null
  const recordBody = isRecord(body) ? body : null
  const id =
    contractBody?.id ??
    (typeof recordBody?.id === 'string' ? recordBody.id : null)
  const url =
    contractBody?.shareUrl ??
    (typeof recordBody?.shareUrl === 'string'
      ? recordBody.shareUrl
      : id
        ? `${baseUrl.replace(/\/$/, '')}/a/${id}`
        : null)
  const warnings = contractBody?.warnings
    ? contractBody.warnings
    : Array.isArray(recordBody?.warnings)
      ? recordBody.warnings.flatMap((warning) => {
          if (!isRecord(warning)) return []
          return warning.code === 'slack_reauthorization_required' &&
            typeof warning.message === 'string'
            ? [
                {
                  code: 'slack_reauthorization_required' as const,
                  message: warning.message,
                },
              ]
            : []
        })
      : []
  return {
    body: {
      id,
      url,
      versionId:
        contractBody?.versionId ??
        (typeof recordBody?.versionId === 'string'
          ? recordBody.versionId
          : null),
      artifactKind:
        contractBody?.artifactKind ??
        (typeof recordBody?.artifactKind === 'string'
          ? recordBody.artifactKind
          : fallbackKind),
      visibility:
        contractBody?.visibility ??
        (typeof recordBody?.visibility === 'string'
          ? recordBody.visibility
          : null),
      linkExpiresAt:
        contractBody?.link_expires_at ??
        (typeof recordBody?.link_expires_at === 'string' ||
        recordBody?.link_expires_at === null
          ? recordBody.link_expires_at
          : null),
      created:
        contractBody?.created ??
        (typeof recordBody?.created === 'boolean' ? recordBody.created : true),
      warnings,
    },
  }
}
