import { isProduction } from './hosts'

export type FlagshipFlagsBinding = {
  getBooleanValue(
    flagKey: string,
    defaultValue: boolean,
    context?: Record<string, string>,
  ): Promise<boolean>
  getStringValue(
    flagKey: string,
    defaultValue: string,
    context?: Record<string, string>,
  ): Promise<string>
}

export type FlagshipSource = {
  APP_ENV?: string
  DEV_FLAGS?: string
  FLAGS?: Partial<FlagshipFlagsBinding>
}

export type FlagshipFlagResult =
  | { kind: 'evaluated'; enabled: boolean }
  | { kind: 'missing-binding'; production: boolean; enabled: boolean }
  | { kind: 'evaluation-error'; error: unknown }

export type FlagshipStringFlagDefinition<Mode extends string> = {
  flagKey: string
  modes: readonly Mode[]
  defaultMode: Mode
}

export type FlagshipFlagRegistration<
  Definition extends FlagshipStringFlagDefinition<string> =
    FlagshipStringFlagDefinition<string>,
> = Definition & {
  expiresOn: `${number}-${number}-${number}`
}

export type FlagshipModeResult<Mode extends string> =
  | { kind: 'evaluated'; mode: Mode }
  | { kind: 'missing-binding'; production: boolean; mode: Mode }
  | { kind: 'evaluation-error'; error: unknown; mode: Mode }

function isDevFlagEnabled(
  devFlags: string | undefined,
  flagKey: string,
): boolean {
  if (!devFlags) return false
  return devFlags
    .split(',')
    .map((key) => key.trim())
    .some((key) => key === flagKey)
}

function getDevFlagMode<Mode extends string>(
  devFlags: string | undefined,
  flagKey: string,
  modes: readonly Mode[],
): Mode | undefined {
  if (!devFlags) return undefined

  for (const entry of devFlags.split(',')) {
    const separator = entry.indexOf('=')
    if (separator === -1) continue

    const key = entry.slice(0, separator).trim()
    const mode = entry.slice(separator + 1).trim()
    if (key === flagKey && modes.some((candidate) => candidate === mode)) {
      return mode as Mode
    }
  }

  return undefined
}

function isCanonicalDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false
  const parsed = new Date(`${value}T00:00:00.000Z`)
  return (
    !Number.isNaN(parsed.getTime()) &&
    parsed.toISOString().slice(0, 10) === value
  )
}

/**
 * Temporary Flagship registrations must use a real UTC calendar date and are
 * invalid after that date. Callers can supply a fixed clock for deterministic
 * validation in tests and build tooling.
 */
export function assertFlagshipRegistrationIsCurrent(
  registration: FlagshipFlagRegistration,
  now = new Date(),
): void {
  if (!isCanonicalDate(registration.expiresOn)) {
    throw new Error(
      `Flagship flag ${registration.flagKey} has an invalid expiry date`,
    )
  }

  const today = now.toISOString().slice(0, 10)
  if (registration.expiresOn < today) {
    throw new Error(`Flagship flag ${registration.flagKey} has expired`)
  }
}

export async function evaluateFlagshipFlag(
  source: FlagshipSource,
  options: {
    flagKey: string
    context: Record<string, string>
    nonProductionDefault?: boolean
  },
): Promise<FlagshipFlagResult> {
  const { flagKey, context, nonProductionDefault = false } = options

  if (typeof source.FLAGS?.getBooleanValue !== 'function') {
    if (isProduction({ APP_ENV: source.APP_ENV ?? '' })) {
      return { kind: 'missing-binding', production: true, enabled: false }
    }
    const enabled =
      isDevFlagEnabled(source.DEV_FLAGS, flagKey) || nonProductionDefault
    return { kind: 'missing-binding', production: false, enabled }
  }

  try {
    const enabled = await source.FLAGS.getBooleanValue(flagKey, false, context)
    return { kind: 'evaluated', enabled }
  } catch (error) {
    return { kind: 'evaluation-error', error }
  }
}

export async function evaluateFlagshipMode<Mode extends string>(
  source: FlagshipSource,
  options: FlagshipStringFlagDefinition<Mode> & {
    context: Record<string, string>
    nonProductionDefault?: Mode
  },
): Promise<FlagshipModeResult<Mode>> {
  const {
    flagKey,
    modes,
    defaultMode,
    context,
    nonProductionDefault = defaultMode,
  } = options

  if (typeof source.FLAGS?.getStringValue !== 'function') {
    if (isProduction({ APP_ENV: source.APP_ENV ?? '' })) {
      return {
        kind: 'missing-binding',
        production: true,
        mode: defaultMode,
      }
    }
    return {
      kind: 'missing-binding',
      production: false,
      mode:
        getDevFlagMode(source.DEV_FLAGS, flagKey, modes) ??
        nonProductionDefault,
    }
  }

  try {
    const mode = await source.FLAGS.getStringValue(
      flagKey,
      defaultMode,
      context,
    )
    if (!modes.some((candidate) => candidate === mode)) {
      return {
        kind: 'evaluation-error',
        error: new Error(`Flagship flag ${flagKey} returned an invalid mode`),
        mode: defaultMode,
      }
    }
    return { kind: 'evaluated', mode: mode as Mode }
  } catch (error) {
    return { kind: 'evaluation-error', error, mode: defaultMode }
  }
}
