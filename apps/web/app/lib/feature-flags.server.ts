import { env } from 'cloudflare:workers'
import { isProduction } from './hosts'

export type FlagshipFlagsBinding = {
  getBooleanValue(
    flagKey: string,
    defaultValue: boolean,
    context?: Record<string, string>,
  ): Promise<boolean>
}

export type FlagSource = {
  APP_ENV?: string
  DEV_FLAGS?: string
  FLAGS?: Partial<FlagshipFlagsBinding>
}

/**
 * Every flag the code reads by name, and what it targets. A flag's target
 * decides the Flagship context it is evaluated with, so two callers of the
 * same flag cannot target it differently.
 */
export const FEATURE_FLAGS = {
  // Gates bot creation only. Existing bots keep running and stop/reissue
  // stay available, so turning the flag off cannot break deployed bots.
  'bot-members': { target: 'workspace' },
  maintenance: { target: 'host' },
} as const satisfies Record<string, { target: FlagTarget }>

type FlagTarget = keyof FlagTargetContext

type FlagTargetContext = {
  workspace: { workspaceId: string }
  host: { hostname: string; pathname: string }
}

export type FeatureFlag = keyof typeof FEATURE_FLAGS

type TargetOf<F extends FeatureFlag> = (typeof FEATURE_FLAGS)[F]['target']

function flagshipContext(
  target: FlagTarget,
  context: FlagTargetContext[FlagTarget],
): Record<string, string> {
  if (target === 'workspace') {
    const { workspaceId } = context as FlagTargetContext['workspace']
    return { targetingKey: workspaceId, workspaceId }
  }
  const { hostname, pathname } = context as FlagTargetContext['host']
  return { targetingKey: hostname, hostname, pathname }
}

function isDevFlagEnabled(devFlags: string | undefined, flagKey: string) {
  return (devFlags ?? '').split(',').some((key) => key.trim() === flagKey)
}

/**
 * Evaluates a flag by key and fails closed: a missing binding in production
 * or an evaluation error reads as off. Outside production, a missing binding
 * (local wrangler dev) reads `DEV_FLAGS`.
 */
export async function isFlagKeyOn(
  source: FlagSource,
  flagKey: string,
  context: Record<string, string>,
): Promise<boolean> {
  if (typeof source.FLAGS?.getBooleanValue !== 'function') {
    if (isProduction({ APP_ENV: source.APP_ENV ?? '' })) {
      console.error('feature_flag_binding_missing_in_production', flagKey)
      return false
    }
    return isDevFlagEnabled(source.DEV_FLAGS, flagKey)
  }
  try {
    return await source.FLAGS.getBooleanValue(flagKey, false, context)
  } catch (error) {
    console.error('feature_flag_evaluation_failed', flagKey, error)
    return false
  }
}

export function isFlagOn<F extends FeatureFlag>(
  flag: F,
  context: FlagTargetContext[TargetOf<F>],
  source: FlagSource = env,
): Promise<boolean> {
  return isFlagKeyOn(
    source,
    flag,
    flagshipContext(FEATURE_FLAGS[flag].target, context),
  )
}
