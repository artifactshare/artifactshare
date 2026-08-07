import { isSandboxMessage, type SandboxMessage } from './csp-reporter'

export function sandboxMessageFromFrame(
  event: MessageEvent,
  trustedOrigin: string,
  trustedWindow: Window | null | undefined,
): SandboxMessage | null {
  if (event.origin !== trustedOrigin) return null
  if (!trustedWindow || event.source !== trustedWindow) return null
  if (!isSandboxMessage(event.data)) return null
  return event.data
}
