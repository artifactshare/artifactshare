import { BridgeValidationError } from './errors.js'
import type {
  BridgeOperation,
  BridgePolicy,
  ConversationKind,
  OwnedBridgeRequest,
  OwnedFile,
  RequestedAudience,
  ShareIntent,
  TrustedHostContext,
} from './types.js'

const encoder = new TextEncoder()
const fatalUtf8Decoder = new TextDecoder('utf-8', { fatal: true })
const OPERATIONS = new Set<BridgeOperation>([
  'publish',
  'append',
  'update',
  'set_visibility',
])
const AUDIENCES = new Set<RequestedAudience>(['private', 'workspace'])
const KINDS = new Set<ConversationKind>([
  'public_channel',
  'private_channel',
  'dm',
])
const WHITESPACE_EDGE = /^\p{White_Space}|\p{White_Space}$/u
const MEDIA_TYPE = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+\/[!#$%&'*+.^_`|~0-9A-Za-z-]+$/
const typedArrayPrototype = Object.getPrototypeOf(
  Uint8Array.prototype,
) as object
const TYPED_ARRAY_BUFFER_GETTER = Object.getOwnPropertyDescriptor(
  typedArrayPrototype,
  'buffer',
)?.get
const TYPED_ARRAY_BYTE_LENGTH_GETTER = Object.getOwnPropertyDescriptor(
  typedArrayPrototype,
  'byteLength',
)?.get
const ARRAY_BUFFER_RESIZABLE_GETTER = Object.getOwnPropertyDescriptor(
  ArrayBuffer.prototype,
  'resizable',
)?.get
const ARRAY_BUFFER_SLICE = ArrayBuffer.prototype.slice

type DataRecord = Record<string, unknown>

interface SnapshotFile {
  path: string
  media_type: string
  bytes: Uint8Array<ArrayBuffer>
}

interface Snapshot {
  intent: Omit<OwnedBridgeRequest['intent'], 'content_kind'> & {
    content_kind?: 'file' | 'static_site'
  }
  context: TrustedHostContext
  files: SnapshotFile[]
}

export function snapshotInputs(
  intentValue: unknown,
  contextValue: unknown,
  policy: BridgePolicy,
  now: Date,
): Snapshot {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new BridgeValidationError('invalid_context')
  }
  const intentSeen = new WeakSet<object>()
  const contextSeen = new WeakSet<object>()
  const intent = dataRecord(
    intentValue,
    [
      'operation',
      'requested_audience',
      'title',
      'target_artifact_id',
      'content',
    ],
    intentSeen,
    'invalid_intent',
  )
  const operation = enumValue(intent.operation, OPERATIONS, 'invalid_intent')
  const requestedAudience = enumValue(
    intent.requested_audience,
    AUDIENCES,
    'invalid_intent',
  )
  const title = optionalBoundedCharacters(intent.title, 200, 'invalid_intent')
  const target = optionalBoundedString(
    intent.target_artifact_id,
    1,
    200,
    'invalid_intent',
  )
  const content = snapshotContent(intent.content, intentSeen)
  validateOperationShape(operation, title, target, content)

  const context = snapshotContext(contextValue, contextSeen, now)
  if (!sameSource(context.source, policy.source)) {
    throw new BridgeValidationError('invalid_context')
  }
  if (
    !policy.allowed_conversations.includes(
      conversationKey(
        context.conversation.kind,
        context.conversation.current_id,
      ),
    )
  ) {
    throw new BridgeValidationError('policy_denied')
  }

  preflightFiles(
    content.files,
    policy.max_payload_bytes,
    content.kind === 'static_site',
  )
  const copied = content.files.map((file) => ({
    path: file.path,
    media_type: file.media_type,
    bytes: new Uint8Array(file.bytes),
  }))
  preflightFiles(
    copied,
    policy.max_payload_bytes,
    content.kind === 'static_site',
  )
  if (operation === 'append' && !validUtf8(copied[0]!.bytes)) invalidIntent()
  copied.sort((left, right) => compareUtf8(left.path, right.path))

  return {
    intent: {
      operation,
      requested_audience: requestedAudience,
      ...(title === undefined ? {} : { title }),
      ...(target === undefined ? {} : { target_artifact_id: target }),
      ...(content.kind === undefined ? {} : { content_kind: content.kind }),
    },
    context,
    files: copied,
  }
}

export async function finalizeSnapshot(
  snapshot: Snapshot,
): Promise<OwnedBridgeRequest> {
  const files: OwnedFile[] = []
  for (const [index, file] of snapshot.files.entries()) {
    const digest = await crypto.subtle.digest('SHA-256', file.bytes)
    files.push(
      Object.freeze({
        index,
        path: file.path,
        media_type: file.media_type,
        bytes: file.bytes,
        size: file.bytes.byteLength,
        sha256: hex(new Uint8Array(digest)),
      }),
    )
  }
  return Object.freeze({
    intent: Object.freeze(snapshot.intent),
    context: deepFreeze(snapshot.context),
    files: Object.freeze(files),
  })
}

function snapshotContent(
  value: unknown,
  seen: WeakSet<object>,
): { kind?: 'file' | 'static_site'; files: SnapshotFile[] } {
  if (value === undefined) return { files: [] }
  const content = dataRecord(
    value,
    ['kind', 'file', 'files'],
    seen,
    'invalid_intent',
  )
  if (content.kind === 'file') {
    if (content.files !== undefined) invalidIntent()
    return { kind: 'file', files: [snapshotFile(content.file, seen)] }
  }
  if (content.kind === 'static_site') {
    if (content.file !== undefined) invalidIntent()
    const values = dataArray(content.files, 50, seen, 'invalid_intent')
    return {
      kind: 'static_site',
      files: values.map((item) => snapshotFile(item, seen)),
    }
  }
  return invalidIntent()
}

function snapshotFile(value: unknown, seen: WeakSet<object>): SnapshotFile {
  const file = dataRecord(
    value,
    ['path', 'media_type', 'bytes'],
    seen,
    'invalid_intent',
  )
  const path = boundedPath(file.path)
  validatePath(path)
  const mediaType = boundedString(file.media_type, 1, 127, 'invalid_intent')
  if (!MEDIA_TYPE.test(mediaType) || mediaType.includes('*')) invalidIntent()
  return { path, media_type: mediaType, bytes: brandedBytes(file.bytes) }
}

function snapshotContext(
  value: unknown,
  seen: WeakSet<object>,
  now: Date,
): TrustedHostContext {
  const context = dataRecord(
    value,
    ['source', 'conversation', 'requester', 'request_id'],
    seen,
    'invalid_context',
  )
  const sourceValue = dataRecord(
    context.source,
    ['kind', 'installation_id', 'external_workspace_id'],
    seen,
    'invalid_context',
  )
  const source = {
    kind: sourceKind(sourceValue.kind),
    installation_id: boundedString(
      sourceValue.installation_id,
      1,
      200,
      'invalid_context',
    ),
    external_workspace_id: boundedString(
      sourceValue.external_workspace_id,
      1,
      200,
      'invalid_context',
    ),
  }
  const conversationValue = dataRecord(
    context.conversation,
    ['current_id', 'ids', 'kind', 'name', 'privacy_checked_at'],
    seen,
    'invalid_context',
  )
  const kind = enumValue(conversationValue.kind, KINDS, 'invalid_context')
  const currentId = boundedString(
    conversationValue.current_id,
    1,
    200,
    'invalid_context',
  )
  const ids = dataArray(conversationValue.ids, 16, seen, 'invalid_context').map(
    (id) => boundedString(id, 1, 200, 'invalid_context'),
  )
  if (
    ids.length < 1 ||
    ids.length > 16 ||
    new Set(ids).size !== ids.length ||
    ids.filter((id) => id === currentId).length !== 1
  ) {
    throw new BridgeValidationError('invalid_context')
  }
  const checkedAt = optionalBoundedString(
    conversationValue.privacy_checked_at,
    1,
    64,
    'invalid_context',
  )
  validatePrivacyTime(kind, checkedAt, now)
  const requesterValue = dataRecord(
    context.requester,
    ['stable_id', 'verified_email', 'display_name'],
    seen,
    'invalid_context',
  )
  const email = boundedString(
    requesterValue.verified_email,
    1,
    320,
    'invalid_context',
  )
  const normalizedEmail = boundedString(
    email.toLowerCase(),
    1,
    320,
    'invalid_context',
  )
  if (
    email !== email.trim() ||
    !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(normalizedEmail)
  ) {
    throw new BridgeValidationError('invalid_context')
  }
  const name = optionalBoundedString(
    conversationValue.name,
    1,
    200,
    'invalid_context',
  )
  const displayName = optionalBoundedString(
    requesterValue.display_name,
    1,
    200,
    'invalid_context',
  )
  return {
    source,
    conversation: {
      current_id: currentId,
      ids,
      kind,
      ...(name === undefined ? {} : { name }),
      ...(checkedAt === undefined ? {} : { privacy_checked_at: checkedAt }),
    },
    requester: {
      stable_id: boundedString(
        requesterValue.stable_id,
        1,
        200,
        'invalid_context',
      ),
      verified_email: normalizedEmail,
      ...(displayName === undefined ? {} : { display_name: displayName }),
    },
    request_id: boundedString(context.request_id, 1, 200, 'invalid_context'),
  }
}

function validateOperationShape(
  operation: BridgeOperation,
  title: string | undefined,
  target: string | undefined,
  content: { kind?: 'file' | 'static_site'; files: SnapshotFile[] },
): void {
  if (content.kind === 'static_site' && content.files.length === 0) {
    invalidIntent()
  }
  if (
    operation === 'publish' &&
    (target !== undefined || content.kind === undefined)
  ) {
    invalidIntent()
  }
  if (
    operation === 'append' &&
    (target === undefined ||
      content.kind !== 'file' ||
      content.files.length !== 1 ||
      byteLength(content.files[0]!.bytes) === 0)
  ) {
    invalidIntent()
  }
  if (
    operation === 'update' &&
    (target === undefined || content.kind === undefined)
  ) {
    invalidIntent()
  }
  if (
    operation === 'set_visibility' &&
    (target === undefined || content.kind !== undefined || title !== undefined)
  ) {
    invalidIntent()
  }
}

function preflightFiles(
  files: SnapshotFile[],
  policyLimit: number,
  staticSite: boolean,
): void {
  if (files.length > 50) invalidIntent()
  let total = 0
  const paths = new Set<string>()
  for (const file of files) {
    const limit = staticSite ? 10_485_760 : 26_214_400
    const size = byteLength(file.bytes)
    if (size > limit || size > policyLimit - total) invalidIntent()
    total += size
    const path = staticSite ? staticSiteCollisionKey(file.path) : file.path
    if (staticSite && staticSiteStoredPath(file.path).length > 256) {
      invalidIntent()
    }
    if (staticSite && !supportedStaticSitePath(file.path)) invalidIntent()
    if (!staticSite && !supportedStandaloneFile(file)) invalidIntent()
    if (paths.has(path)) invalidIntent()
    paths.add(path)
  }
  if (total > 26_214_400 || total > policyLimit) invalidIntent()
  if (staticSite && !paths.has('index.html') && !paths.has('index.md')) {
    invalidIntent()
  }
  for (const path of paths) {
    const parts = path.split('/')
    for (let depth = 1; depth < parts.length; depth += 1) {
      if (paths.has(parts.slice(0, depth).join('/'))) invalidIntent()
    }
  }
}

function supportedStandaloneFile(file: SnapshotFile): boolean {
  return (
    /\.(?:html?|md|markdown)$/iu.test(file.path) ||
    file.media_type === 'text/html' ||
    file.media_type === 'text/markdown'
  )
}

function supportedStaticSitePath(path: string): boolean {
  return /\.(?:html?|css|js|json|xml|webmanifest|map|data|rsc|meta|md|markdown|txt|svg|png|jpe?g|gif|webp|avif|mp4|ico|woff2?)$/iu.test(
    path,
  )
}

function validUtf8(bytes: Uint8Array<ArrayBuffer>): boolean {
  try {
    fatalUtf8Decoder.decode(bytes)
    return true
  } catch {
    return false
  }
}

function staticSiteStoredPath(path: string): string {
  return `/${path}`.normalize('NFC')
}

function staticSiteCollisionKey(path: string): string {
  return staticSiteStoredPath(path).toLowerCase().slice(1)
}

function validatePath(path: string): void {
  if (
    path.startsWith('/') ||
    path.endsWith('/') ||
    path.includes('\\') ||
    /^[A-Za-z]:\//u.test(path) ||
    /[#?]/u.test(path) ||
    /\.(?:exe|sh|php|py|rb|bat|cmd|dll|so)$/iu.test(path) ||
    hasAsciiControl(path)
  ) {
    invalidIntent()
  }
  const parts = path.split('/')
  if (
    parts.length > 11 ||
    parts.some(
      (part) =>
        part.trim() === '' || part.trim() === '.' || part.trim() === '..',
    )
  ) {
    invalidIntent()
  }
}

function brandedBytes(value: unknown): Uint8Array<ArrayBuffer> {
  if (typeof value !== 'object' || value === null) invalidIntent()
  if (!ArrayBuffer.isView(value) || !(value instanceof Uint8Array)) {
    invalidIntent()
  }
  if (
    TYPED_ARRAY_BUFFER_GETTER === undefined ||
    TYPED_ARRAY_BYTE_LENGTH_GETTER === undefined
  ) {
    invalidIntent()
  }
  const bytes = value as Uint8Array<ArrayBufferLike>
  const buffer = Reflect.apply(TYPED_ARRAY_BUFFER_GETTER, bytes, []) as unknown
  if (!(buffer instanceof ArrayBuffer)) invalidIntent()
  const resizable =
    ARRAY_BUFFER_RESIZABLE_GETTER === undefined
      ? false
      : Reflect.apply(ARRAY_BUFFER_RESIZABLE_GETTER, buffer, [])
  if (resizable === true) invalidIntent()
  try {
    Reflect.apply(ARRAY_BUFFER_SLICE, buffer, [0, 0])
  } catch {
    invalidIntent()
  }
  const fixedBytes = bytes as Uint8Array<ArrayBuffer>
  byteLength(fixedBytes)
  return fixedBytes
}

function byteLength(bytes: Uint8Array<ArrayBuffer>): number {
  if (TYPED_ARRAY_BYTE_LENGTH_GETTER === undefined) invalidIntent()
  const length = Reflect.apply(
    TYPED_ARRAY_BYTE_LENGTH_GETTER,
    bytes,
    [],
  ) as unknown
  if (
    typeof length !== 'number' ||
    !Number.isSafeInteger(length) ||
    length < 0
  ) {
    invalidIntent()
  }
  return length
}

function dataRecord(
  value: unknown,
  allowed: readonly string[],
  seen: WeakSet<object>,
  code: 'invalid_intent' | 'invalid_context',
): DataRecord {
  if (typeof value !== 'object' || value === null || seen.has(value)) {
    throw new BridgeValidationError(code)
  }
  seen.add(value)
  if (Object.getPrototypeOf(value) !== Object.prototype) {
    throw new BridgeValidationError(code)
  }
  const descriptors = Object.getOwnPropertyDescriptors(value) as Record<
    string,
    PropertyDescriptor
  >
  const keys = Reflect.ownKeys(descriptors)
  if (keys.some((key) => typeof key !== 'string' || !allowed.includes(key))) {
    throw new BridgeValidationError(code)
  }
  const result: DataRecord = {}
  for (const key of keys as string[]) {
    const descriptor = descriptors[key]
    if (!descriptor || !('value' in descriptor))
      throw new BridgeValidationError(code)
    result[key] = descriptor.value
  }
  return result
}

function dataArray(
  value: unknown,
  maxLength: number,
  seen: WeakSet<object>,
  code: 'invalid_intent' | 'invalid_context',
): unknown[] {
  if (!Array.isArray(value) || seen.has(value))
    throw new BridgeValidationError(code)
  seen.add(value)
  const initialLengthDescriptor = Object.getOwnPropertyDescriptor(
    value,
    'length',
  )
  const initialLength = initialLengthDescriptor?.value
  if (
    !initialLengthDescriptor ||
    !('value' in initialLengthDescriptor) ||
    !Number.isSafeInteger(initialLength) ||
    initialLength < 0 ||
    initialLength > maxLength
  ) {
    throw new BridgeValidationError(code)
  }
  const descriptors = Object.getOwnPropertyDescriptors(value) as Record<
    string,
    PropertyDescriptor
  >
  const lengthDescriptor = descriptors['length']
  const length = lengthDescriptor?.value
  if (length !== initialLength) throw new BridgeValidationError(code)
  const result: unknown[] = []
  for (let index = 0; index < length; index += 1) {
    const descriptor = descriptors[String(index)]
    if (!descriptor || !('value' in descriptor))
      throw new BridgeValidationError(code)
    result.push(descriptor.value)
  }
  if (Reflect.ownKeys(descriptors).length !== length + 1) {
    throw new BridgeValidationError(code)
  }
  return result
}

function boundedString(
  value: unknown,
  min: number,
  max: number,
  code: 'invalid_intent' | 'invalid_context',
  rejectEdgeWhitespace = true,
): string {
  if (typeof value !== 'string') throw new BridgeValidationError(code)
  const size = utf8Length(value, code)
  if (
    size < min ||
    size > max ||
    (rejectEdgeWhitespace && WHITESPACE_EDGE.test(value)) ||
    hasAsciiControl(value)
  ) {
    throw new BridgeValidationError(code)
  }
  return value
}

function boundedPath(value: unknown): string {
  if (typeof value !== 'string') invalidIntent()
  utf8Length(value, 'invalid_intent')
  // Artifact Share's product contract defines this limit in JavaScript
  // characters (`pathChars`), while payload limits are measured in bytes.
  if (value.length < 1 || value.length > 256 || hasAsciiControl(value)) {
    invalidIntent()
  }
  return value
}

function optionalBoundedString(
  value: unknown,
  min: number,
  max: number,
  code: 'invalid_intent' | 'invalid_context',
): string | undefined {
  return value === undefined ? undefined : boundedString(value, min, max, code)
}

function optionalBoundedCharacters(
  value: unknown,
  max: number,
  code: 'invalid_intent' | 'invalid_context',
): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string') throw new BridgeValidationError(code)
  utf8Length(value, code)
  if (
    value.length < 1 ||
    value.length > max ||
    WHITESPACE_EDGE.test(value) ||
    hasAsciiControl(value)
  ) {
    throw new BridgeValidationError(code)
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

function utf8Length(
  value: string,
  code: 'invalid_intent' | 'invalid_context',
): number {
  let total = 0
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index)
    if (unit <= 0x7f) total += 1
    else if (unit <= 0x7ff) total += 2
    else if (unit >= 0xd800 && unit <= 0xdbff) {
      const low = value.charCodeAt(index + 1)
      if (!Number.isInteger(low) || low < 0xdc00 || low > 0xdfff) {
        throw new BridgeValidationError(code)
      }
      total += 4
      index += 1
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      throw new BridgeValidationError(code)
    } else total += 3
  }
  return total
}

function enumValue<T extends string>(
  value: unknown,
  accepted: ReadonlySet<T>,
  code: 'invalid_intent' | 'invalid_context',
): T {
  if (typeof value !== 'string' || !accepted.has(value as T)) {
    throw new BridgeValidationError(code)
  }
  return value as T
}

function sourceKind(value: unknown): string {
  const kind = boundedString(value, 1, 64, 'invalid_context')
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(kind)) {
    throw new BridgeValidationError('invalid_context')
  }
  return kind
}

function validatePrivacyTime(
  kind: ConversationKind,
  value: string | undefined,
  now: Date,
): void {
  if (kind === 'public_channel' && value === undefined) {
    throw new BridgeValidationError('invalid_context')
  }
  if (value === undefined) return
  const parsed = Date.parse(value)
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    throw new BridgeValidationError('invalid_context')
  }
  if (kind === 'public_channel') {
    const age = now.getTime() - parsed
    if (age < -5_000) {
      throw new BridgeValidationError('invalid_context')
    }
  }
}

function sameSource(
  left: TrustedHostContext['source'],
  right: TrustedHostContext['source'],
): boolean {
  return (
    left.kind === right.kind &&
    left.installation_id === right.installation_id &&
    left.external_workspace_id === right.external_workspace_id
  )
}

export function conversationKey(kind: ConversationKind, id: string): string {
  return `${kind}\u0000${id}`
}

function compareUtf8(left: string, right: string): number {
  const a = encoder.encode(left)
  const b = encoder.encode(right)
  for (let index = 0; index < Math.min(a.length, b.length); index += 1) {
    if (a[index] !== b[index]) return (a[index] ?? 0) - (b[index] ?? 0)
  }
  return a.length - b.length
}

function hex(bytes: Uint8Array): string {
  return [...bytes].map((value) => value.toString(16).padStart(2, '0')).join('')
}

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null) {
    Object.freeze(value)
    for (const child of Object.values(value)) deepFreeze(child)
  }
  return value
}

function invalidIntent(): never {
  throw new BridgeValidationError('invalid_intent')
}
