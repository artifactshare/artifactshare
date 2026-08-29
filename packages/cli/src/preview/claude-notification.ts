import type { PreviewAgentNotificationRegistration } from './contract.js'

const CLAUDE_SESSION_PATTERN = /^[a-zA-Z0-9_-]{1,128}$/

function backgroundAvailable(environment: NodeJS.ProcessEnv): boolean {
  const disabled =
    environment.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS?.trim().toLowerCase()
  return disabled !== '1' && disabled !== 'true'
}

export function claudeNotificationRegistration(
  environment: NodeJS.ProcessEnv = process.env,
  now: () => Date = () => new Date(),
): PreviewAgentNotificationRegistration | null {
  const sessionId = environment.CLAUDE_CODE_SESSION_ID?.trim() ?? ''
  if (sessionId === '') return null
  if (!CLAUDE_SESSION_PATTERN.test(sessionId)) {
    return {
      provider: 'claude_code',
      transport: 'manual',
      capability: 'manual',
      target: null,
      registered_at: now().toISOString(),
    }
  }
  const available = backgroundAvailable(environment)
  return {
    provider: 'claude_code',
    transport: available ? 'background_wait' : 'manual',
    capability: available ? 'wait' : 'manual',
    target: null,
    registered_at: now().toISOString(),
  }
}
