import { isProduction } from './hosts'

export type FlagshipFlagsBinding = {
  getBooleanValue(
    flagKey: string,
    defaultValue: boolean,
    context?: Record<string, string>,
  ): Promise<boolean>
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
