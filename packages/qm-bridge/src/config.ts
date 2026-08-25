import { BridgeValidationError } from './errors.js'
import type {
  BridgePolicy,
  ConversationKind,
  ValidatedBridgeConfig,
} from './types.js'
import { conversationKey } from './validation.js'

const KINDS = new Set<ConversationKind>([
  'public_channel',
  'private_channel',
  'dm',
])
const WHITESPACE_EDGE = /^\p{White_Space}|\p{White_Space}$/u

export function validateBridgeConfig(value: unknown): ValidatedBridgeConfig {
  const record = exactRecord(value, [
    'base_url',
    'source',
    'request_timeout_ms',
    'max_payload_bytes',
    'allowed_conversations',
  ])
  const source = exactRecord(record.source, [
    'kind',
    'installation_id',
    'external_workspace_id',
  ])
  const normalizedSource = {
    kind: configString(source.kind, 64, /^[a-z0-9][a-z0-9_-]*$/),
    installation_id: configString(source.installation_id, 200),
    external_workspace_id: configString(source.external_workspace_id, 200),
  }
  const conversations = exactArray(record.allowed_conversations, 1, 1024)
  const seen = new Set<string>()
  const allowed = conversations.map((entry) => {
    const item = exactRecord(entry, ['kind', 'current_id'])
    const kind = item.kind
    if (typeof kind !== 'string' || !KINDS.has(kind as ConversationKind)) {
      invalidConfig()
    }
    const normalized = {
      kind: kind as ConversationKind,
      current_id: configString(item.current_id, 200),
    }
    const key = conversationKey(normalized.kind, normalized.current_id)
    if (seen.has(key)) invalidConfig()
    seen.add(key)
    return Object.freeze(normalized)
  })
  return Object.freeze({
    base_url: validateBaseUrl(record.base_url),
    source: Object.freeze(normalizedSource),
    request_timeout_ms: boundedInteger(
      record.request_timeout_ms,
      30_000,
      100,
      300_000,
    ),
    max_payload_bytes: boundedInteger(
      record.max_payload_bytes,
      26_214_400,
      1,
      26_214_400,
    ),
    allowed_conversations: Object.freeze(allowed),
  })
}

export function createBridgePolicy(
  config: ValidatedBridgeConfig,
): BridgePolicy {
  return Object.freeze({
    base_url: config.base_url,
    source: config.source,
    max_payload_bytes: config.max_payload_bytes,
    allowed_conversations: Object.freeze(
      config.allowed_conversations.map((entry) =>
        conversationKey(entry.kind, entry.current_id),
      ),
    ),
  })
}

export function validateBaseUrl(value: unknown): string {
  if (typeof value !== 'string') invalidConfig()
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return invalidConfig()
  }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  if (
    (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) ||
    url.username !== '' ||
    url.password !== '' ||
    url.pathname !== '/' ||
    url.search !== '' ||
    url.hash !== ''
  ) {
    invalidConfig()
  }
  return url.origin
}

function exactRecord(
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    invalidConfig()
  }
  const descriptors = Object.getOwnPropertyDescriptors(value) as Record<
    string,
    PropertyDescriptor
  >
  const ownKeys = Reflect.ownKeys(descriptors)
  if (ownKeys.some((key) => typeof key !== 'string' || !keys.includes(key))) {
    invalidConfig()
  }
  const result: Record<string, unknown> = {}
  for (const key of ownKeys as string[]) {
    const descriptor = descriptors[key]
    if (!descriptor || !('value' in descriptor)) invalidConfig()
    result[key] = descriptor.value
  }
  return result
}

function exactArray(
  value: unknown,
  minLength: number,
  maxLength: number,
): unknown[] {
  if (!Array.isArray(value)) invalidConfig()
  const descriptors = Object.getOwnPropertyDescriptors(value) as Record<
    string,
    PropertyDescriptor
  >
  const length = descriptors['length']?.value
  if (
    !Number.isSafeInteger(length) ||
    length < minLength ||
    length > maxLength ||
    Reflect.ownKeys(descriptors).length !== length + 1
  ) {
    invalidConfig()
  }
  const result: unknown[] = []
  for (let index = 0; index < length; index += 1) {
    const descriptor = descriptors[String(index)]
    if (!descriptor || !('value' in descriptor)) invalidConfig()
    result.push(descriptor.value)
  }
  return result
}

function configString(value: unknown, max: number, pattern?: RegExp): string {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    utf8Length(value) > max ||
    WHITESPACE_EDGE.test(value) ||
    hasAsciiControl(value) ||
    (pattern !== undefined && !pattern.test(value))
  ) {
    invalidConfig()
  }
  return value
}

function hasAsciiControl(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index)
    if (unit <= 0x1f || unit === 0x7f) return true
  }
  return false
}

function utf8Length(value: string): number {
  let total = 0
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index)
    if (unit <= 0x7f) total += 1
    else if (unit <= 0x7ff) total += 2
    else if (unit >= 0xd800 && unit <= 0xdbff) {
      const low = value.charCodeAt(index + 1)
      if (!Number.isInteger(low) || low < 0xdc00 || low > 0xdfff) {
        invalidConfig()
      }
      total += 4
      index += 1
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      invalidConfig()
    } else total += 3
  }
  return total
}

function boundedInteger(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
): number {
  const resolved = value === undefined ? fallback : value
  if (
    !Number.isSafeInteger(resolved) ||
    (resolved as number) < min ||
    (resolved as number) > max
  ) {
    invalidConfig()
  }
  return resolved as number
}

function invalidConfig(): never {
  throw new BridgeValidationError('invalid_context')
}
