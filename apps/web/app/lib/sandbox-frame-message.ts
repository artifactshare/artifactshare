import {
  SANDBOX_EXTERNAL_LINK_POLICY_MESSAGE,
  isSandboxMessage,
  type SandboxMessage,
} from './csp-reporter'

export function sandboxExternalLinkPolicyMessage(
  mode: 'parent' | 'direct' = 'parent',
) {
  return { ...SANDBOX_EXTERNAL_LINK_POLICY_MESSAGE, mode }
}

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
