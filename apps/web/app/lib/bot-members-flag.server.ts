import { env } from 'cloudflare:workers'
import {
  evaluateFlagshipFlag,
  type FlagshipFlagsBinding,
} from './flagship-fallback.server'

export const BOT_MEMBERS_FLAG_KEY = 'bot-members'

export type BotMembersFlagEnv = {
  APP_ENV: string
  FLAGS?: Partial<FlagshipFlagsBinding>
}

/**
 * Workspace-scoped gate for bot CREATION only (UI entry and API). Existing
 * bots keep running, and stop/reissue stay available regardless of the flag,
 * so a later flag removal cannot break deployed bots. Fails closed: a missing
 * binding or evaluation error disables creation.
 */
export async function isBotMembersEnabled(
  workspaceId: string,
  source: BotMembersFlagEnv = env,
): Promise<boolean> {
  const result = await evaluateFlagshipFlag(source, {
    flagKey: BOT_MEMBERS_FLAG_KEY,
    context: { targetingKey: workspaceId, workspaceId },
    nonProductionDefault: false,
  })
  switch (result.kind) {
    case 'evaluated':
      return result.enabled
    case 'missing-binding':
      return result.production ? false : result.enabled
    case 'evaluation-error':
      console.error('bot_members_flag_evaluation_failed', result.error)
      return false
  }
}
