import type { TrustedHostContext } from './types.js'

export interface QmAuthenticatedContext {
  installationId: string
  workspaceId: string
  conversation: {
    currentId: string
    formerIds?: string[]
    kind: TrustedHostContext['conversation']['kind']
    name?: string
    privacyCheckedAt?: string
  }
  requester: {
    stableId: string
    verifiedEmail: string
    displayName?: string
  }
  requestId: string
}

export function normalizeQmAuthenticatedContext(
  value: QmAuthenticatedContext,
): TrustedHostContext {
  const conversationIds = [
    ...new Set([
      value.conversation.currentId,
      ...(value.conversation.formerIds ?? []),
    ]),
  ].slice(0, 16)
  return {
    source: {
      kind: 'qm',
      installation_id: value.installationId,
      external_workspace_id: value.workspaceId,
    },
    conversation: {
      current_id: value.conversation.currentId,
      ids: conversationIds,
      kind: value.conversation.kind,
      ...(value.conversation.name === undefined
        ? {}
        : { name: value.conversation.name }),
      ...(value.conversation.privacyCheckedAt === undefined
        ? {}
        : { privacy_checked_at: value.conversation.privacyCheckedAt }),
    },
    requester: {
      stable_id: value.requester.stableId,
      verified_email: value.requester.verifiedEmail,
      ...(value.requester.displayName === undefined
        ? {}
        : { display_name: value.requester.displayName }),
    },
    request_id: value.requestId,
  }
}
