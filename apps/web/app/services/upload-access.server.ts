import {
  checkUploadPermission,
  type UploadPermissionResult,
  type UploadPermissionUser,
} from '~/lib/upload-permission.server'

/**
 * Whether the user may publish. `upload-allowed` is a global kill switch, so
 * evaluation failures and missing bindings fail closed.
 */
export async function checkUploadAccess(
  user: UploadPermissionUser,
): Promise<UploadPermissionResult> {
  if (user.selfUploadEnabled !== true) {
    return { kind: 'self-upload-disabled' }
  }

  return await checkUploadPermission(user)
}
