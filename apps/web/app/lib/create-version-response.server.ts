import type { CreateVersionResult } from '~/services/shareables.server'
import {
  errorResponse,
  quotaExceededResponse,
  workspaceAccessRevokedResponse,
} from './api-errors'

export function createVersionFailureResponse(
  result: Exclude<CreateVersionResult, { kind: 'ok' }>,
  copyForbidden: () => Response,
): Response {
  switch (result.kind) {
    case 'not-found':
      return errorResponse('not-found', 'Shareable not found.', 404)
    case 'copy-forbidden':
      return copyForbidden()
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
    case 'workspace-access-revoked':
      return workspaceAccessRevokedResponse()
    case 'too-large':
      return errorResponse('too-large', 'File is larger than 25 MB.', 413)
    case 'quota-exceeded':
      return quotaExceededResponse()
    case 'storage-failed':
      return errorResponse(
        'storage-failed',
        'Could not save the file. Try again.',
        502,
      )
    case 'invalid-container':
      return errorResponse(
        'invalid-container',
        'Invalid upload destination.',
        400,
      )
    default: {
      const _exhaustive: never = result
      return _exhaustive
    }
  }
}
