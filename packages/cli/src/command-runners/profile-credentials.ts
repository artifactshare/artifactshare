import type { CliOptions, ProfileConfigEntry } from '../types.js'
import { DEFAULT_BASE_URL } from '../constants.js'
import {
  deleteProfileCredential,
  nonEmpty,
  type DeleteProfileCredentialResult,
} from '../token-store.js'
import { isRecord } from '../validators.js'

export async function deleteCredentialForProfileEntry(
  profile: string,
  rawEntry: unknown,
  options: CliOptions,
): Promise<DeleteProfileCredentialResult> {
  const entry = isRecord(rawEntry) ? (rawEntry as ProfileConfigEntry) : {}
  return await deleteProfileCredential(profile, {
    ...options,
    baseUrl: nonEmpty(entry.base_url) ?? DEFAULT_BASE_URL,
  })
}
