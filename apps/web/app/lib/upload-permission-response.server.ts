import { selfUploadDisabledResponse } from './api-errors'
import type { UploadPermissionResult } from '~/services/upload-access.server'

export function uploadPermissionFailureResponse(
  _permission: Exclude<UploadPermissionResult, { kind: 'allowed' }>,
): Response {
  return selfUploadDisabledResponse()
}
