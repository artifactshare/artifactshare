export type UploadPermissionUser = {
  selfUploadEnabled?: boolean
}

export type UploadPermissionResult =
  | { kind: 'allowed' }
  | { kind: 'self-upload-disabled' }

export function checkUploadAccess(
  user: UploadPermissionUser,
): UploadPermissionResult {
  return user.selfUploadEnabled === true
    ? { kind: 'allowed' }
    : { kind: 'self-upload-disabled' }
}
