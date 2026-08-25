import type { CliAuthority } from './cli-authority.server'

const CONTEXT_FRESHNESS_MS = 60_000
const CONTEXT_FUTURE_SKEW_MS = 5_000
const encoder = new TextEncoder()

type BridgeAuthority = Extract<CliAuthority, { kind: 'bridge' }>
type ConversationKind = 'public_channel' | 'private_channel' | 'dm'
type BridgeOperation = 'publish' | 'append' | 'update' | 'set_visibility'
type RequestedAudience = 'private' | 'workspace'

export interface TrustedBridgeContext {
  requestId: string
  source: {
    kind: string
    installationId: string
    externalWorkspaceId: string
  }
  conversation: {
    currentId: string
    ids: string[]
    kind: ConversationKind
    name: string | null
    privacyCheckedAt: string | null
  }
  requester: {
    stableId: string
    verifiedEmail: string
    displayName: string | null
  }
}

export interface BridgeContentFile {
  index: number
  path: string
  mediaType: string
  size: number
  sha256: string
}

export interface BridgeIntent {
  operation: BridgeOperation
  requestedAudience: RequestedAudience
  targetArtifactId: string | null
  title: string | null
  contentKind: 'file' | 'static_site' | null
  files: BridgeContentFile[]
}

export type ContextValidationResult =
  | { kind: 'ok'; context: TrustedBridgeContext }
  | { kind: 'invalid-context' | 'stale-context' }

export type IntentValidationResult =
  | { kind: 'ok'; intent: BridgeIntent }
  | { kind: 'invalid-context' }

export function parseTrustedBridgeContext(
  value: unknown,
  authority: BridgeAuthority,
  now = new Date(),
): ContextValidationResult {
  const root = exactRecord(value, [
    'schema_version',
    'request_id',
    'operation',
    'requested_audience',
    'target_artifact_id',
    'title',
    'source',
    'conversation',
    'requester',
    'content',
  ])
  if (!root || root.schema_version !== 1) return { kind: 'invalid-context' }
  const source = exactRecord(root.source, [
    'kind',
    'installation_id',
    'external_workspace_id',
  ])
  const conversation = exactRecord(root.conversation, [
    'current_id',
    'ids',
    'kind',
    'name',
    'privacy_checked_at',
  ])
  const requester = exactRecord(root.requester, [
    'stable_id',
    'verified_email',
    'display_name',
  ])
  if (!source || !conversation || !requester) {
    return { kind: 'invalid-context' }
  }

  const sourceKind = boundedString(source.kind, 64)
  const installationId = boundedString(source.installation_id, 200)
  const externalWorkspaceId = boundedString(source.external_workspace_id, 200)
  const requestId = boundedString(root.request_id, 200)
  const currentId = boundedString(conversation.current_id, 200)
  const stableId = boundedString(requester.stable_id, 200)
  const verifiedEmail = normalizedEmail(requester.verified_email)
  if (
    !sourceKind ||
    !/^[a-z0-9][a-z0-9_-]*$/.test(sourceKind) ||
    !installationId ||
    !externalWorkspaceId ||
    !requestId ||
    !currentId ||
    !stableId ||
    !verifiedEmail ||
    sourceKind !== authority.sourceKind ||
    installationId !== authority.sourceInstallationId ||
    externalWorkspaceId !== authority.externalWorkspaceId
  ) {
    return { kind: 'invalid-context' }
  }
  if (!Array.isArray(conversation.ids) || conversation.ids.length === 0) {
    return { kind: 'invalid-context' }
  }
  const ids = conversation.ids.map((id) => boundedString(id, 200))
  if (
    ids.length > 16 ||
    ids.some((id) => id === null) ||
    new Set(ids).size !== ids.length ||
    ids.filter((id) => id === currentId).length !== 1
  ) {
    return { kind: 'invalid-context' }
  }
  const kind = conversation.kind
  if (
    kind !== 'public_channel' &&
    kind !== 'private_channel' &&
    kind !== 'dm'
  ) {
    return { kind: 'invalid-context' }
  }
  const name = optionalBoundedString(conversation.name, 200)
  const displayName = optionalBoundedString(requester.display_name, 200)
  const privacyCheckedAt = optionalBoundedString(
    conversation.privacy_checked_at,
    64,
  )
  if (name === false || displayName === false || privacyCheckedAt === false) {
    return { kind: 'invalid-context' }
  }
  if (kind === 'public_channel') {
    if (privacyCheckedAt === null) return { kind: 'invalid-context' }
    const checkedAt = Date.parse(privacyCheckedAt)
    if (
      !Number.isFinite(checkedAt) ||
      new Date(checkedAt).toISOString() !== privacyCheckedAt
    ) {
      return { kind: 'invalid-context' }
    }
    const age = now.getTime() - checkedAt
    if (age > CONTEXT_FRESHNESS_MS || age < -CONTEXT_FUTURE_SKEW_MS) {
      return { kind: 'stale-context' }
    }
  }

  return {
    kind: 'ok',
    context: {
      requestId,
      source: { kind: sourceKind, installationId, externalWorkspaceId },
      conversation: {
        currentId,
        ids: ids as string[],
        kind,
        name,
        privacyCheckedAt,
      },
      requester: { stableId, verifiedEmail, displayName },
    },
  }
}

export function parseBridgeIntent(value: unknown): IntentValidationResult {
  const root = exactRecord(value, [
    'schema_version',
    'request_id',
    'operation',
    'requested_audience',
    'target_artifact_id',
    'title',
    'source',
    'conversation',
    'requester',
    'content',
  ])
  if (!root || root.schema_version !== 1) return { kind: 'invalid-context' }
  const operation = root.operation
  const requestedAudience = root.requested_audience
  if (
    (operation !== 'publish' &&
      operation !== 'append' &&
      operation !== 'update' &&
      operation !== 'set_visibility') ||
    (requestedAudience !== 'private' && requestedAudience !== 'workspace')
  ) {
    return { kind: 'invalid-context' }
  }
  const targetArtifactId = optionalBoundedString(root.target_artifact_id, 200)
  const title = optionalBoundedCharacters(root.title, 200)
  if (targetArtifactId === false || title === false) {
    return { kind: 'invalid-context' }
  }
  let contentKind: BridgeIntent['contentKind'] = null
  let files: BridgeContentFile[] = []
  if (root.content !== undefined) {
    const content = exactRecord(root.content, ['kind', 'files'])
    if (
      !content ||
      (content.kind !== 'file' && content.kind !== 'static_site') ||
      !Array.isArray(content.files) ||
      content.files.length > 50
    ) {
      return { kind: 'invalid-context' }
    }
    contentKind = content.kind
    const parsed = content.files.map(parseFileDescriptor)
    if (parsed.some((file) => file === null)) {
      return { kind: 'invalid-context' }
    }
    files = parsed as BridgeContentFile[]
    if (
      files.some((file, index) => file.index !== index) ||
      new Set(files.map((file) => file.path.toLowerCase())).size !==
        files.length
    ) {
      return { kind: 'invalid-context' }
    }
  }
  const hasContent = contentKind !== null
  if (
    (operation === 'publish' && (targetArtifactId !== null || !hasContent)) ||
    (operation === 'append' &&
      (targetArtifactId === null ||
        contentKind !== 'file' ||
        files.length !== 1)) ||
    (operation === 'update' && (targetArtifactId === null || !hasContent)) ||
    (operation === 'set_visibility' &&
      (targetArtifactId === null || hasContent || title !== null)) ||
    (contentKind === 'file' && files.length !== 1) ||
    (contentKind === 'static_site' && files.length === 0)
  ) {
    return { kind: 'invalid-context' }
  }
  return {
    kind: 'ok',
    intent: {
      operation,
      requestedAudience,
      targetArtifactId,
      title,
      contentKind,
      files,
    },
  }
}

function parseFileDescriptor(value: unknown): BridgeContentFile | null {
  const file = exactRecord(value, [
    'index',
    'path',
    'media_type',
    'size',
    'sha256',
  ])
  if (!file) return null
  const path = boundedCharacters(file.path, 256)
  const mediaType = boundedString(file.media_type, 127)
  if (
    !Number.isSafeInteger(file.index) ||
    (file.index as number) < 0 ||
    !path ||
    !mediaType ||
    !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+\/[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(
      mediaType,
    ) ||
    !Number.isSafeInteger(file.size) ||
    (file.size as number) < 0 ||
    typeof file.sha256 !== 'string' ||
    !/^[0-9a-f]{64}$/.test(file.sha256)
  ) {
    return null
  }
  return {
    index: file.index as number,
    path,
    mediaType,
    size: file.size as number,
    sha256: file.sha256,
  }
}

function exactRecord(
  value: unknown,
  allowedKeys: readonly string[],
): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null
  }
  const record = value as Record<string, unknown>
  const allowed = new Set(allowedKeys)
  if (Object.keys(record).some((key) => !allowed.has(key))) return null
  return record
}

function boundedString(value: unknown, maxBytes: number): string | null {
  if (typeof value !== 'string' || value.trim() !== value) return null
  if (
    value.length === 0 ||
    encoder.encode(value).byteLength > maxBytes ||
    containsControlCharacters(value)
  ) {
    return null
  }
  return value
}

function boundedCharacters(value: unknown, max: number): string | null {
  if (typeof value !== 'string' || value.trim() !== value) return null
  if (
    value.length === 0 ||
    value.length > max ||
    containsControlCharacters(value)
  ) {
    return null
  }
  return value
}

function containsControlCharacters(value: string): boolean {
  return Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0) ?? 0
    return codePoint <= 0x1f || codePoint === 0x7f
  })
}

function optionalBoundedString(
  value: unknown,
  maxBytes: number,
): string | null | false {
  if (value === undefined) return null
  return boundedString(value, maxBytes) ?? false
}

function optionalBoundedCharacters(
  value: unknown,
  max: number,
): string | null | false {
  if (value === undefined) return null
  return boundedCharacters(value, max) ?? false
}

function normalizedEmail(value: unknown): string | null {
  const email = boundedString(value, 320)
  if (!email) return null
  const normalized = email.toLowerCase()
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(normalized) ? normalized : null
}
