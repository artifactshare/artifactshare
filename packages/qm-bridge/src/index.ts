export { createBridgePolicy, validateBridgeConfig } from './config.js'
export { BridgeValidationError } from './errors.js'
export type {
  BridgeClient,
  BridgeConfig,
  BridgeCredential,
  BridgeErrorCode,
  BridgeFailure,
  BridgeOperation,
  BridgePolicy,
  BridgeResult,
  BridgeSuccess,
  ConversationKind,
  ContentKind,
  CredentialProvider,
  IntentContent,
  IntentFile,
  OwnedBridgeRequest,
  OwnedFile,
  RequestedAudience,
  ShareIntent,
  TrustedHostContext,
  ValidatedBridgeConfig,
} from './types.js'

import { BridgeValidationError, failure } from './errors.js'
import type {
  BridgeClient,
  BridgePolicy,
  BridgeResult,
  CredentialProvider,
  ShareIntent,
  TrustedHostContext,
} from './types.js'
import { finalizeSnapshot, snapshotInputs } from './validation.js'
import { metadataOverflowCode } from './wire.js'

export function publishTrusted(options: {
  intent: ShareIntent | unknown
  context: TrustedHostContext | unknown
  credentialProvider: CredentialProvider
  client: BridgeClient
  policy: BridgePolicy
  clock?: () => Date
}): Promise<BridgeResult> {
  let snapshot
  try {
    snapshot = snapshotInputs(
      options.intent,
      options.context,
      options.policy,
      options.clock?.() ?? new Date(),
    )
  } catch (error) {
    const code = validationErrorCode(error)
    if (code !== undefined) return Promise.resolve(failure(code))
    return Promise.resolve(failure('internal_error'))
  }
  return execute(
    snapshot,
    options.credentialProvider,
    options.client,
    options.policy.base_url,
  )
}

function validationErrorCode(
  error: unknown,
): BridgeValidationError['code'] | undefined {
  try {
    if (
      typeof error !== 'object' ||
      error === null ||
      Object.getPrototypeOf(error) !== BridgeValidationError.prototype
    ) {
      return undefined
    }
    const descriptor = Object.getOwnPropertyDescriptor(error, 'code')
    const code =
      descriptor && 'value' in descriptor ? descriptor.value : undefined
    return code === 'invalid_intent' ||
      code === 'invalid_context' ||
      code === 'policy_denied'
      ? code
      : undefined
  } catch {
    return undefined
  }
}

async function execute(
  snapshot: Parameters<typeof finalizeSnapshot>[0],
  credentialProvider: CredentialProvider,
  client: BridgeClient,
  baseUrl: string,
): Promise<BridgeResult> {
  let credentialOrigin
  try {
    credentialOrigin = client.credentialOrigin
  } catch {
    return failure('invalid_context')
  }
  if (credentialOrigin !== baseUrl) return failure('invalid_context')
  let request
  try {
    request = await finalizeSnapshot(snapshot)
  } catch {
    return failure('internal_error')
  }
  const overflow = metadataOverflowCode(request)
  if (overflow !== undefined) return failure(overflow)
  let credential
  try {
    credential = await credentialProvider()
    if (
      typeof credential !== 'object' ||
      credential === null ||
      typeof credential.bearer_token !== 'string' ||
      !/^[\x21-\x7e]+$/u.test(credential.bearer_token)
    ) {
      return failure('credential_unavailable')
    }
  } catch {
    return failure('credential_unavailable')
  }
  try {
    const result = await client.request(request, credential)
    return normalizeClientResult(result, request, baseUrl)
  } catch {
    return failure('transport_error', { retryable: true })
  }
}

function normalizeClientResult(
  value: unknown,
  request: Awaited<ReturnType<typeof finalizeSnapshot>>,
  baseUrl: string,
): BridgeResult {
  const root = exactResultRecord(value, [
    'ok',
    'artifact',
    'project',
    'visibility',
    'version_id',
    'replayed',
    'mapping_created',
    'project_created',
    'code',
    'message',
    'retryable',
    'retry_after_ms',
    'server_code',
  ])
  if (root === undefined || typeof root.ok !== 'boolean') {
    return failure('invalid_server_response')
  }
  if (!root.ok) {
    if (
      !onlyResultKeys(root, [
        'ok',
        'code',
        'message',
        'retryable',
        'retry_after_ms',
        'server_code',
      ])
    ) {
      return failure('invalid_server_response')
    }
    const code = root.code
    if (
      typeof code !== 'string' ||
      ![
        'invalid_intent',
        'invalid_context',
        'policy_denied',
        'credential_unavailable',
        'transport_error',
        'timeout',
        'bridge_rejected',
        'invalid_server_response',
        'internal_error',
      ].includes(code) ||
      typeof root.retryable !== 'boolean' ||
      (root.retry_after_ms !== undefined &&
        (!root.retryable ||
          !Number.isInteger(root.retry_after_ms) ||
          (root.retry_after_ms as number) < 100 ||
          (root.retry_after_ms as number) > 300_000)) ||
      (root.server_code !== undefined && !resultServerCode(root.server_code))
    ) {
      return failure('invalid_server_response')
    }
    return failure(code as Parameters<typeof failure>[0], {
      retryable: root.retryable,
      ...(root.retry_after_ms === undefined
        ? {}
        : { retry_after_ms: root.retry_after_ms as number }),
      ...(root.server_code === undefined
        ? {}
        : { server_code: root.server_code as string }),
    })
  }
  const artifact = exactResultRecord(root.artifact, ['id', 'url', 'title'])
  const project = exactResultRecord(root.project, ['id', 'name'])
  if (
    !onlyResultKeys(root, [
      'ok',
      'artifact',
      'project',
      'visibility',
      'version_id',
      'replayed',
      'mapping_created',
      'project_created',
    ]) ||
    artifact === undefined ||
    project === undefined ||
    !resultString(artifact.id, 200) ||
    !sameOriginUrl(artifact.url, baseUrl) ||
    !resultCharacters(artifact.title, 200) ||
    !resultString(project.id, 200) ||
    !resultCharacters(project.name, 120) ||
    (root.visibility !== 'private' && root.visibility !== 'workspace') ||
    typeof root.replayed !== 'boolean' ||
    typeof root.mapping_created !== 'boolean' ||
    typeof root.project_created !== 'boolean' ||
    (request.intent.operation === 'set_visibility'
      ? root.version_id !== null
      : !resultString(root.version_id, 200))
  ) {
    return failure('invalid_server_response')
  }
  const target = request.intent.target_artifact_id
  if (target !== undefined && artifact.id !== target) {
    return failure('invalid_server_response')
  }
  if (
    request.intent.requested_audience === 'private' &&
    root.visibility !== 'private'
  ) {
    return failure('invalid_server_response')
  }
  return {
    ok: true,
    artifact: artifact as unknown as { id: string; url: string; title: string },
    project: project as unknown as { id: string; name: string },
    visibility: root.visibility,
    version_id: root.version_id as string | null,
    replayed: root.replayed,
    mapping_created: root.mapping_created,
    project_created: root.project_created,
  }
}

function exactResultRecord(
  value: unknown,
  allowed: readonly string[],
): Record<string, unknown> | undefined {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    return undefined
  }
  const descriptors = Object.getOwnPropertyDescriptors(value)
  if (
    Reflect.ownKeys(descriptors).some(
      (key) =>
        typeof key !== 'string' ||
        !allowed.includes(key) ||
        !('value' in descriptors[key]!),
    )
  ) {
    return undefined
  }
  return Object.fromEntries(
    Object.entries(descriptors).map(([key, descriptor]) => [
      key,
      descriptor.value,
    ]),
  )
}

function resultString(value: unknown, max: number): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    isWellFormed(value) &&
    new TextEncoder().encode(value).byteLength <= max &&
    !hasAsciiControl(value)
  )
}

function resultCharacters(value: unknown, max: number): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    isWellFormed(value) &&
    value.length <= max &&
    !hasAsciiControl(value)
  )
}

function isWellFormed(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index)
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const low = value.charCodeAt(index + 1)
      if (!Number.isInteger(low) || low < 0xdc00 || low > 0xdfff) return false
      index += 1
    } else if (unit >= 0xdc00 && unit <= 0xdfff) return false
  }
  return true
}

function sameOriginUrl(value: unknown, baseUrl: string): value is string {
  if (!resultString(value, 2048) || hasAsciiControl(value)) {
    return false
  }
  try {
    const url = new URL(value)
    return (
      url.origin === baseUrl &&
      url.username === '' &&
      url.password === '' &&
      url.href === value
    )
  } catch {
    return false
  }
}

function hasAsciiControl(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index)
    if (unit <= 0x1f || unit === 0x7f) return true
  }
  return false
}

function resultServerCode(value: unknown): value is string {
  return (
    resultString(value, 200) &&
    value === value.trim() &&
    /^[\x20-\x7e]+$/u.test(value)
  )
}

function onlyResultKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
): boolean {
  return Object.keys(value).every((key) => allowed.includes(key))
}
