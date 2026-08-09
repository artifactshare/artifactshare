import type { CliOptions, ProfileConfigEntry } from '../types.js'
import { DEFAULT_BASE_URL } from '../constants.js'
import {
  deleteProfileCredential,
  nonEmpty,
  readProfileToken,
  type DeleteProfileCredentialResult,
} from '../token-store.js'
import { isRecord } from '../validators.js'

export async function deleteCredentialForProfileEntry(
  profile: string,
  rawEntry: unknown,
  options: CliOptions,
): Promise<DeleteProfileCredentialResult> {
  return await deleteProfileCredential(
    profile,
    optionsForProfileEntry(rawEntry, options),
  )
}

export async function readCredentialForProfileEntry(
  profile: string,
  rawEntry: unknown,
  options: CliOptions,
) {
  return await readProfileToken(
    profile,
    optionsForProfileEntry(rawEntry, options),
  )
}

export function optionsForProfileEntry(
  rawEntry: unknown,
  options: CliOptions,
): CliOptions {
  const entry = isRecord(rawEntry) ? (rawEntry as ProfileConfigEntry) : {}
  return {
    ...options,
    baseUrl: nonEmpty(entry.base_url) ?? DEFAULT_BASE_URL,
  }
}
