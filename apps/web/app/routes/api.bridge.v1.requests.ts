import {
  FormDataParseError,
  MaxFilesExceededError,
  parseFormData,
} from '@remix-run/form-data-parser'
import {
  MaxFileSizeExceededError,
  MaxHeaderSizeExceededError,
  MultipartParseError,
  MaxPartsExceededError,
  MaxTotalSizeExceededError,
} from '@remix-run/multipart-parser'
import { bridgeErrorResponse } from '~/lib/bridge-api.server'
import { requireBridgeBearerMiddleware } from '~/middleware/auth'
import { getCliAuthority, requireUser } from '~/middleware/context'
import { executeBridgeRequest } from '~/services/bridge-publishing.server'
import { createDb } from '~/services/db.server'
import type { Route } from './+types/api.bridge.v1.requests'

const MAX_METADATA_BYTES = 65_536
const MAX_CONTENT_BYTES = 26_214_400

export const middleware = [requireBridgeBearerMiddleware]

export async function action({ request, context }: Route.ActionArgs) {
  const authority = getCliAuthority(context)
  if (authority?.kind !== 'bridge') {
    return bridgeErrorResponse(
      'unsupported-authority',
      'This credential is not a bridge authority.',
      403,
    )
  }
  let form: FormData
  try {
    form = await parseFormData(
      request,
      {
        maxFiles: 50,
        maxFileSize: MAX_CONTENT_BYTES,
        maxTotalSize: MAX_CONTENT_BYTES + MAX_METADATA_BYTES,
        maxParts: 51,
      },
      (file) => file,
    )
  } catch (error) {
    if (
      error instanceof MaxFilesExceededError ||
      error instanceof MaxFileSizeExceededError ||
      error instanceof MaxHeaderSizeExceededError ||
      error instanceof MaxTotalSizeExceededError ||
      error instanceof MaxPartsExceededError
    ) {
      return bridgeErrorResponse(
        'payload-too-large',
        'The bridge request exceeds the upload envelope.',
        413,
      )
    }
    if (
      error instanceof FormDataParseError ||
      error instanceof MultipartParseError
    ) {
      return bridgeErrorResponse(
        'invalid-context',
        'The bridge multipart request is invalid.',
        400,
      )
    }
    throw error
  }
  if ([...form.keys()].some((key) => key !== 'metadata' && key !== 'file')) {
    return bridgeErrorResponse(
      'invalid-context',
      'The bridge multipart fields are invalid.',
      400,
    )
  }
  const metadataParts = form.getAll('metadata')
  const rawMetadata = metadataParts[0]
  if (
    metadataParts.length !== 1 ||
    typeof rawMetadata !== 'string' ||
    new TextEncoder().encode(rawMetadata).byteLength > MAX_METADATA_BYTES
  ) {
    return bridgeErrorResponse(
      'invalid-context',
      'The trusted bridge metadata is missing or invalid.',
      400,
    )
  }
  let metadata: unknown
  try {
    metadata = JSON.parse(rawMetadata)
  } catch {
    return bridgeErrorResponse(
      'invalid-context',
      'The trusted bridge metadata is not valid JSON.',
      400,
    )
  }
  const files = form.getAll('file')
  if (files.some((file) => !(file instanceof File))) {
    return bridgeErrorResponse(
      'invalid-context',
      'The bridge file parts are invalid.',
      400,
    )
  }
  let result: Awaited<ReturnType<typeof executeBridgeRequest>>
  try {
    result = await executeBridgeRequest(
      createDb(),
      authority,
      requireUser(context),
      metadata,
      files as File[],
      new URL(request.url).origin,
    )
  } catch (error) {
    console.error('bridge_request_failed', error)
    return failureResponse('internal-error')
  }
  if (result.kind !== 'ok') return failureResponse(result.kind)
  return Response.json({
    schema_version: 1,
    ok: true,
    data: {
      artifact: result.result.artifact,
      project: result.result.project,
      visibility: result.result.visibility,
      version_id: result.result.versionId,
      replayed: result.result.replayed,
      mapping_created: result.result.mappingCreated,
      project_created: result.result.projectCreated,
    },
  })
}

function failureResponse(
  kind: Exclude<Awaited<ReturnType<typeof executeBridgeRequest>>['kind'], 'ok'>,
) {
  switch (kind) {
    case 'invalid-context':
      return bridgeErrorResponse(
        kind,
        'The trusted bridge context is invalid.',
        400,
      )
    case 'stale-context':
      return bridgeErrorResponse(
        kind,
        'The public conversation context is stale.',
        409,
      )
    case 'unsupported-authority':
      return bridgeErrorResponse(
        kind,
        'The bridge authority is unavailable.',
        403,
      )
    case 'fallback-invalid':
      return bridgeErrorResponse(
        kind,
        'The bridge fallback project is unavailable.',
        409,
      )
    case 'requester-mismatch':
      return bridgeErrorResponse(
        kind,
        'The request belongs to another requester.',
        409,
      )
    case 'mapping-archived':
      return bridgeErrorResponse(kind, 'The mapped project is archived.', 409)
    case 'conversation-identity-conflict':
      return bridgeErrorResponse(
        kind,
        'The conversation identities conflict.',
        409,
      )
    case 'project-limit-reached':
    case 'project-name-conflict':
    case 'artifact-viewer-limit-reached':
    case 'forbidden-target':
      return bridgeErrorResponse(
        kind,
        'The bridge operation cannot be completed.',
        409,
      )
    case 'idempotency-in-progress':
      return bridgeErrorResponse(
        kind,
        'The same request is still in progress.',
        409,
        {
          retryable: true,
          retryAfterMs: 1_000,
        },
      )
    case 'idempotency-mismatch':
      return bridgeErrorResponse(
        kind,
        'The request id was reused with different content.',
        409,
      )
    case 'payload-too-large':
      return bridgeErrorResponse(kind, 'The bridge payload is too large.', 413)
    case 'upload-failed':
    case 'internal-error':
      return bridgeErrorResponse(kind, 'The bridge operation failed.', 500, {
        retryable: true,
        retryAfterMs: 1_000,
      })
  }
}
