import {
  ARTIFACT_KEY_MAX_LENGTH,
  REFRESH_CREDENTIAL_TTL_DAYS,
} from '@artifactshare/contract'

export const ARTIFACT_UPLOAD_LIMITS = {
  totalBytes: 25 * 1024 * 1024,
} as const

export const STATIC_SITE_UPLOAD_LIMITS = {
  files: 50,
  totalBytes: ARTIFACT_UPLOAD_LIMITS.totalBytes,
  fileBytes: 10 * 1024 * 1024,
  pathChars: 256,
  folderDepth: 10,
} as const

export { ARTIFACT_KEY_MAX_LENGTH, REFRESH_CREDENTIAL_TTL_DAYS }

export const REFRESH_CREDENTIAL_TTL_MS =
  REFRESH_CREDENTIAL_TTL_DAYS * 24 * 60 * 60 * 1000
