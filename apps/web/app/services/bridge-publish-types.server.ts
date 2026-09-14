export interface BridgeRequestSuccess {
  artifact: { id: string; url: string; title: string }
  project: { id: string; name: string }
  visibility: 'private' | 'workspace'
  versionId: string | null
  replayed: boolean
  mappingCreated: boolean
  projectCreated: boolean
}

export type BridgePublishResult =
  | { kind: 'ok'; result: BridgeRequestSuccess }
  | {
      kind:
        | 'invalid-context'
        | 'stale-context'
        | 'unsupported-authority'
        | 'fallback-invalid'
        | 'requester-mismatch'
        | 'mapping-archived'
        | 'conversation-identity-conflict'
        | 'project-limit-reached'
        | 'project-name-conflict'
        | 'internal-error'
        | 'idempotency-in-progress'
        | 'idempotency-mismatch'
        | 'payload-too-large'
        | 'upload-failed'
        | 'forbidden-target'
        | 'artifact-viewer-limit-reached'
    }

export type BridgePublishUser = {
  id: string
  kind?: 'human' | 'bot'
  email?: string | null
  emailVerified?: boolean
  workspaceId: string
  hd?: string | null
  msTenantId?: string | null
}

export type VerifiedBridgeFile = {
  file: File
  path: string
  mediaType: string
}
