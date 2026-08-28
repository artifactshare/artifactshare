import type { FormData } from 'undici'
import type { ApiErrorOptions, CliError, FetchInit } from './types.js'
import { cliFetch, readJson } from './api.js'
import { mapApiError, networkError } from './errors.js'

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
  const id = body?.id ?? null
  const url =
    body?.shareUrl ?? (id ? `${baseUrl.replace(/\/$/, '')}/a/${id}` : null)
  const warnings = Array.isArray(body?.warnings)
    ? body.warnings.flatMap((warning: { code?: unknown; message?: unknown }) =>
        warning?.code === 'slack_reauthorization_required' &&
        typeof warning.message === 'string'
          ? [
              {
                code: 'slack_reauthorization_required' as const,
                message: warning.message,
              },
            ]
          : [],
      )
    : []
  return {
    body: {
      id,
      url,
      versionId: body?.versionId ?? null,
      artifactKind: body?.artifactKind ?? fallbackKind,
      visibility: body?.visibility ?? null,
      linkExpiresAt: body?.link_expires_at ?? null,
      created: body?.created ?? true,
      warnings,
    },
  }
}
