export type BridgeOperation = 'publish' | 'append' | 'update' | 'set_visibility'
export type RequestedAudience = 'private' | 'workspace'
export type ConversationKind = 'public_channel' | 'private_channel' | 'dm'
export type ContentKind = 'file' | 'static_site'

export interface IntentFile {
  path: string
  media_type: string
  bytes: Uint8Array
}

export type IntentContent =
  | { kind: 'file'; file: IntentFile }
  | { kind: 'static_site'; files: IntentFile[] }

export interface ShareIntent {
  operation: BridgeOperation
  requested_audience: RequestedAudience
  title?: string
  target_artifact_id?: string
  content?: IntentContent
}

export interface TrustedHostContext {
  source: {
    kind: string
    installation_id: string
    external_workspace_id: string
  }
  conversation: {
    current_id: string
    ids: string[]
    kind: ConversationKind
    name?: string
    privacy_checked_at?: string
  }
  requester: {
    stable_id: string
    verified_email: string
    display_name?: string
  }
  request_id: string
}

export interface BridgeConfig {
  base_url: string
  source: TrustedHostContext['source']
  request_timeout_ms?: number
  max_payload_bytes?: number
  allowed_conversations: Array<{
    kind: ConversationKind
    current_id: string
  }>
}

export interface ValidatedBridgeConfig {
  readonly base_url: string
  readonly source: Readonly<TrustedHostContext['source']>
  readonly request_timeout_ms: number
  readonly max_payload_bytes: number
  readonly allowed_conversations: ReadonlyArray<
    Readonly<{ kind: ConversationKind; current_id: string }>
  >
}

export interface BridgePolicy {
  readonly base_url: string
  readonly source: Readonly<TrustedHostContext['source']>
  readonly max_payload_bytes: number
  readonly allowed_conversations: readonly string[]
}

export interface BridgeCredential {
  readonly bearer_token: string
}

export type BridgeErrorCode =
  | 'invalid_intent'
  | 'invalid_context'
  | 'policy_denied'
  | 'credential_unavailable'
  | 'transport_error'
  | 'timeout'
  | 'bridge_rejected'
  | 'invalid_server_response'
  | 'internal_error'

export interface BridgeSuccess {
  ok: true
  artifact: { id: string; url: string; title: string }
  project: { id: string; name: string }
  visibility: RequestedAudience
  version_id: string | null
  replayed: boolean
  mapping_created: boolean
  project_created: boolean
}

export interface BridgeFailure {
  ok: false
  code: BridgeErrorCode
  message: string
  retryable: boolean
  retry_after_ms?: number
  server_code?: string
}

export type BridgeResult = BridgeSuccess | BridgeFailure

export interface OwnedFile {
  readonly index: number
  readonly path: string
  readonly media_type: string
  readonly bytes: Uint8Array
  readonly size: number
  readonly sha256: string
}

export interface OwnedBridgeRequest {
  readonly intent: Readonly<{
    operation: BridgeOperation
    requested_audience: RequestedAudience
    title?: string
    target_artifact_id?: string
    content_kind?: ContentKind
  }>
  readonly context: Readonly<TrustedHostContext>
  readonly files: ReadonlyArray<OwnedFile>
}

export interface BridgeClient {
  readonly credentialOrigin: string
  request(
    request: OwnedBridgeRequest,
    credential: BridgeCredential,
  ): Promise<BridgeResult>
}

export type CredentialProvider = () => Promise<BridgeCredential>
