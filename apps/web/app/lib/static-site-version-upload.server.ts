import { parseFormData } from '@remix-run/form-data-parser'
import type { Kysely } from 'kysely'
import type { Visibility } from '~/lib/shareable-types'
import type { DB } from '~/types/db'
import type { CliAuthority } from '~/services/cli-authority.server'
import {
  beginStaticSiteBundleVersionUploadSession,
  type StaticSiteBundleVersionUploadSessionResult,
  type UpdateStaticSiteBundleResult,
} from '~/services/shareables.server'
import { errorResponse, workspaceAccessRevokedResponse } from './api-errors'
import {
  MAX_STATIC_SITE_UPLOAD_FILE_BYTES,
  MAX_STATIC_SITE_UPLOAD_FILES,
  MAX_STATIC_SITE_UPLOAD_PARTS,
  MAX_STATIC_SITE_UPLOAD_TOTAL_BYTES,
  staticSiteBundleResponse,
  staticSiteParseErrorResponse,
} from './static-site-upload-response.server'

class StaticSiteUpdateRejected extends Error {
  constructor(readonly result: UpdateStaticSiteBundleResult) {
    super(result.kind)
    this.name = 'StaticSiteUpdateRejected'
  }
}

export async function runStaticSiteVersionUpload(
  db: Kysely<DB>,
  request: Request,
  user: {
    id: string
    email: string
    workspaceId: string
    hd: string | null
  },
  shareableId: string,
  options: {
    touchArtifactKeyId?: string | null
    extraOkFields?: {
      visibility?: Visibility
      link_expires_at?: string | null
      created?: boolean
    }
    waitUntil?: (promise: Promise<unknown>) => void
    authority?: CliAuthority | null
    expectedCurrentVersionId?: string
    agentProfileId?: string | null
  } = {},
): Promise<Response> {
  const begun = await beginStaticSiteBundleVersionUploadSession(
    db,
    user,
    shareableId,
    options.touchArtifactKeyId ?? null,
    {
      ...(options.waitUntil ? { waitUntil: options.waitUntil } : {}),
      ...(options.authority ? { authority: options.authority } : {}),
      ...(options.expectedCurrentVersionId
        ? { expectedCurrentVersionId: options.expectedCurrentVersionId }
        : {}),
      ...(options.agentProfileId
        ? { agentProfileId: options.agentProfileId }
        : {}),
    },
  )
  if (begun.kind !== 'ok') return staticSiteSessionBeginResponse(begun)
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
        if (result.kind !== 'ok') {
          throw new StaticSiteUpdateRejected(result)
        }
        return null
      },
    )
  } catch (error) {
    if (error instanceof StaticSiteUpdateRejected) {
      await session.abort()
      return staticSiteBundleResponse(request, error.result)
    }
    const response = staticSiteParseErrorResponse(error)
    if (response) {
      await session.abort()
      return response
    }
    await session.abort()
    throw error
  }

  if (session.fileCount === 0) {
    await session.abort()
    return errorResponse('missing-file', 'File is required.', 400)
  }

  const result = await session.commitVersion()
  return staticSiteBundleResponse(request, result, options.extraOkFields)
}

function staticSiteSessionBeginResponse(
  result: Exclude<StaticSiteBundleVersionUploadSessionResult, { kind: 'ok' }>,
): Response {
  switch (result.kind) {
    case 'not-found':
      return errorResponse('not-found', 'Shareable not found.', 404)
    case 'copy-forbidden':
      return errorResponse(
        'copy-forbidden',
        'This artifact is not a static site.',
        403,
      )
    case 'workspace-access-revoked':
      return workspaceAccessRevokedResponse()
    case 'storage-failed':
      return errorResponse(
        'storage-failed',
        'Could not save the files. Try again.',
        502,
      )
    case 'invalid-container':
      return errorResponse(
        'invalid-container',
        'Invalid upload destination.',
        400,
      )
  }
}
