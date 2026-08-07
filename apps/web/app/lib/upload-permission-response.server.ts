import {
  selfUploadDisabledResponse,
  uploadNotAllowedResponse,
  uploadPolicyUnavailableResponse,
} from './api-errors'
import {
  logUploadPermissionFailure,
  type UploadPermissionResult,
} from './upload-permission.server'

export function uploadPermissionFailureResponse(
  permission: Exclude<UploadPermissionResult, { kind: 'allowed' }>,
): Response {
  logUploadPermissionFailure(permission)
  if (permission.kind === 'self-upload-disabled') {
    return selfUploadDisabledResponse()
  }
  return permission.kind === 'not-allowed'
    ? uploadNotAllowedResponse()
    : uploadPolicyUnavailableResponse()
}
