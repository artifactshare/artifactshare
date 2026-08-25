import { failure } from './errors.js'
import type {
  BridgeClient,
  BridgeCredential,
  BridgeFailure,
  BridgeOperation,
  BridgeResult,
  OwnedBridgeRequest,
  RequestedAudience,
} from './types.js'
import { metadataOverflowCode, requestMetadata } from './wire.js'

const encoder = new TextEncoder()
const decoder = new TextDecoder('utf-8', { fatal: true })
const OPERATIONS: BridgeOperation[] = [
  'publish',
  'append',
  'update',
  'set_visibility',
]
const SERVER_CODES = new Set([
  'invalid-context',
  'stale-context',
  'unauthorized',
  'unsupported-authority',
  'fallback-invalid',
  'requester-mismatch',
  'mapping-archived',
  'conversation-identity-conflict',
  'project-limit-reached',
  'artifact-viewer-limit-reached',
  'project-name-conflict',
  'idempotency-in-progress',
  'idempotency-mismatch',
  'payload-too-large',
  'upload-failed',
  'forbidden-target',
  'rate-limited',
  'internal-error',
])

export interface BridgeHealth {
  authority: 'available'
  operations: BridgeOperation[]
}

export interface ArtifactShareBridgeClientOptions {
  baseUrl: string
  fetch?: typeof fetch
  timeoutMs?: number
  userAgent?: string
  randomBytes?: (length: number) => Uint8Array
}

export class ArtifactShareBridgeClient implements BridgeClient {
  readonly #baseUrl: string
  readonly #fetch: typeof fetch
  readonly #timeoutMs: number
  readonly #userAgent: string
  readonly #randomBytes: (length: number) => Uint8Array

  constructor(options: ArtifactShareBridgeClientOptions) {
    this.#baseUrl = validateOrigin(options.baseUrl)
    this.#fetch = options.fetch ?? globalThis.fetch
    this.#timeoutMs = integer(options.timeoutMs ?? 30_000, 100, 300_000)
    this.#userAgent = boundedVisible(
      options.userAgent ?? 'artifactshare-qm-bridge',
    )
    this.#randomBytes = options.randomBytes ?? webRandomBytes
  }

  get credentialOrigin(): string {
    return this.#baseUrl
  }

  async health(
    credential: BridgeCredential,
  ): Promise<BridgeHealth | BridgeFailure> {
    const result = await this.#send('/api/bridge/v1/health', credential, {
      method: 'GET',
    })
    if (!result.ok) return result.failure
    const body = strictRecord(result.body, ['schema_version', 'ok', 'data'])
    if (body === undefined || body.schema_version !== 1 || body.ok !== true) {
      return failure('invalid_server_response')
    }
    const data = strictRecord(body.data, ['authority', 'operations'])
    if (
      data === undefined ||
      data.authority !== 'available' ||
      !Array.isArray(data.operations)
    ) {
      return failure('invalid_server_response')
    }
    const operations = data.operations
    const operationIndices = operations.map((item) =>
      OPERATIONS.indexOf(item as BridgeOperation),
    )
    if (
      operations.some((item) => typeof item !== 'string') ||
      operationIndices.some((index) => index < 0) ||
      new Set(operationIndices).size !== operationIndices.length
    ) {
      return failure('invalid_server_response')
    }
    return {
      authority: 'available',
      operations: operations as BridgeOperation[],
    }
  }

  async request(
    request: OwnedBridgeRequest,
    credential: BridgeCredential,
  ): Promise<BridgeResult> {
    const metadata = requestMetadata(request)
    const encodedMetadata = encoder.encode(JSON.stringify(metadata))
    const overflow = metadataOverflowCode(request)
    if (overflow !== undefined) return failure(overflow)
    let boundary: string
    try {
      boundary = makeBoundary(this.#randomBytes)
    } catch {
      return failure('internal_error')
    }
    const body = multipartBody(boundary, encodedMetadata, request)
    const result = await this.#send('/api/bridge/v1/requests', credential, {
      method: 'POST',
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      body: body.buffer,
    })
    if (!result.ok) return result.failure
    return parseRequestSuccess(result.body, request, this.#baseUrl)
  }

  async #send(
    path: string,
    credential: BridgeCredential,
    init: RequestInit,
  ): Promise<
    { ok: true; body: unknown } | { ok: false; failure: BridgeFailure }
  > {
    if (
      typeof credential !== 'object' ||
      credential === null ||
      typeof credential.bearer_token !== 'string' ||
      !/^[\x21-\x7e]+$/u.test(credential.bearer_token)
    ) {
      return { ok: false, failure: failure('credential_unavailable') }
    }
    const controller = new AbortController()
    const timeoutHandle = setTimeout(() => controller.abort(), this.#timeoutMs)
    try {
      let response: Response
      try {
        response = await this.#fetch(`${this.#baseUrl}${path}`, {
          ...init,
          redirect: 'manual',
          signal: controller.signal,
          headers: {
            ...init.headers,
            accept: 'application/json',
            authorization: `Bearer ${credential.bearer_token}`,
            'user-agent': this.#userAgent,
          },
        })
      } catch {
        return {
          ok: false,
          failure: failure(
            controller.signal.aborted ? 'timeout' : 'transport_error',
            {
              retryable: true,
            },
          ),
        }
      }
      if (response.status >= 300 && response.status < 400) {
        await cancelBody(response)
        return { ok: false, failure: failure('invalid_server_response') }
      }
      const contentType =
        response.headers.get('content-type')?.toLowerCase() ?? ''
      if (!/^application\/json(?:\s*;|$)/.test(contentType)) {
        await cancelBody(response)
        return {
          ok: false,
          failure: invalidResponseFailure(response.status),
        }
      }
      let bytes: Uint8Array | undefined
      try {
        bytes = await readBounded(response)
      } catch {
        return {
          ok: false,
          failure: failure(
            controller.signal.aborted ? 'timeout' : 'transport_error',
            {
              retryable: true,
            },
          ),
        }
      }
      if (bytes === undefined) {
        return { ok: false, failure: invalidResponseFailure(response.status) }
      }
      let body: unknown
      try {
        body = JSON.parse(decoder.decode(bytes))
      } catch {
        return { ok: false, failure: invalidResponseFailure(response.status) }
      }
      if (!response.ok) {
        const applicationFailure = parseApplicationError(body)
        return {
          ok: false,
          failure:
            applicationFailure.code === 'invalid_server_response'
              ? invalidResponseFailure(response.status)
              : applicationFailure,
        }
      }
      if (response.status !== 200) {
        return { ok: false, failure: failure('invalid_server_response') }
      }
      return { ok: true, body }
    } finally {
      clearTimeout(timeoutHandle)
    }
  }
}

function invalidResponseFailure(status: number): BridgeFailure {
  return status >= 500
    ? failure('transport_error', { retryable: true })
    : failure('invalid_server_response')
}

async function cancelBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel()
  } catch {
    // The response is already rejected; cancellation is best-effort cleanup.
  }
}

export function createArtifactShareBridgeClient(
  options: ArtifactShareBridgeClientOptions,
): ArtifactShareBridgeClient {
  return new ArtifactShareBridgeClient(options)
}

function multipartBody(
  boundary: string,
  metadata: Uint8Array,
  request: OwnedBridgeRequest,
): Uint8Array<ArrayBuffer> {
  const chunks: Uint8Array[] = [
    encoder.encode(
      `--${boundary}\r\nContent-Disposition: form-data; name="metadata"\r\nContent-Type: application/json\r\n\r\n`,
    ),
    metadata,
    encoder.encode('\r\n'),
  ]
  for (const file of request.files) {
    chunks.push(
      encoder.encode(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="file-${file.index}"\r\nContent-Type: ${file.media_type}\r\n\r\n`,
      ),
      file.bytes,
      encoder.encode('\r\n'),
    )
  }
  chunks.push(encoder.encode(`--${boundary}--\r\n`))
  const size = chunks.reduce((total, chunk) => total + chunk.byteLength, 0)
  const body = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    body.set(chunk, offset)
    offset += chunk.byteLength
  }
  return body
}

function parseRequestSuccess(
  value: unknown,
  request: OwnedBridgeRequest,
  baseUrl: string,
): BridgeResult {
  const root = strictRecord(value, ['schema_version', 'ok', 'data'])
  if (root === undefined || root.schema_version !== 1 || root.ok !== true) {
    return failure('invalid_server_response')
  }
  const data = strictRecord(root.data, [
    'artifact',
    'project',
    'visibility',
    'version_id',
    'replayed',
    'mapping_created',
    'project_created',
  ])
  const artifact = strictRecord(data?.artifact, ['id', 'url', 'title'])
  const project = strictRecord(data?.project, ['id', 'name'])
  if (
    data === undefined ||
    artifact === undefined ||
    project === undefined ||
    !boundedString(artifact.id, 200) ||
    !boundedCharacters(artifact.title, 200) ||
    !boundedString(project.id, 200) ||
    !boundedCharacters(project.name, 120) ||
    !sameOriginUrl(artifact.url, baseUrl) ||
    !isAudience(data.visibility) ||
    typeof data.replayed !== 'boolean' ||
    typeof data.mapping_created !== 'boolean' ||
    typeof data.project_created !== 'boolean'
  ) {
    return failure('invalid_server_response')
  }
  const version = data.version_id
  if (
    (request.intent.operation === 'set_visibility' && version !== null) ||
    (request.intent.operation !== 'set_visibility' &&
      !boundedString(version, 200)) ||
    (request.intent.target_artifact_id !== undefined &&
      artifact.id !== request.intent.target_artifact_id) ||
    (request.intent.requested_audience === 'private' &&
      data.visibility !== 'private')
  ) {
    return failure('invalid_server_response')
  }
  return {
    ok: true,
    artifact: artifact as unknown as { id: string; url: string; title: string },
    project: project as unknown as { id: string; name: string },
    visibility: data.visibility,
    version_id: version as string | null,
    replayed: data.replayed,
    mapping_created: data.mapping_created,
    project_created: data.project_created,
  }
}

function parseApplicationError(value: unknown): BridgeFailure {
  const root = strictRecord(value, ['schema_version', 'ok', 'error'])
  const error = strictRecord(root?.error, [
    'code',
    'message',
    'retryable',
    'retry_after_ms',
  ])
  if (
    root === undefined ||
    root.schema_version !== 1 ||
    root.ok !== false ||
    error === undefined ||
    typeof error.code !== 'string' ||
    !SERVER_CODES.has(error.code) ||
    !boundedString(error.message, 500) ||
    typeof error.retryable !== 'boolean'
  ) {
    return failure('invalid_server_response')
  }
  if (
    error.retry_after_ms !== undefined &&
    (!error.retryable ||
      !Number.isInteger(error.retry_after_ms) ||
      (error.retry_after_ms as number) < 100 ||
      (error.retry_after_ms as number) > 300_000)
  ) {
    return failure('invalid_server_response')
  }
  return failure('bridge_rejected', {
    retryable: error.retryable,
    server_code: error.code,
    ...(error.retry_after_ms === undefined
      ? {}
      : { retry_after_ms: error.retry_after_ms as number }),
  })
}

async function readBounded(
  response: Response,
): Promise<Uint8Array | undefined> {
  const declared = response.headers.get('content-length')
  if (declared !== null && Number(declared) > 65_536) {
    await response.body?.cancel()
    return undefined
  }
  if (response.body === null) return new Uint8Array()
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  while (true) {
    const next = await reader.read()
    if (next.done) break
    total += next.value.byteLength
    if (total > 65_536) {
      await reader.cancel()
      return undefined
    }
    chunks.push(next.value)
  }
  const output = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    output.set(chunk, offset)
    offset += chunk.byteLength
  }
  return output
}

function strictRecord(
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> | undefined {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !keys.includes(key))
  ) {
    return undefined
  }
  return value as Record<string, unknown>
}

function makeBoundary(randomBytes: (length: number) => Uint8Array): string {
  const bytes = randomBytes(16)
  if (!(bytes instanceof Uint8Array) || bytes.byteLength !== 16) {
    throw new TypeError('Random byte provider returned invalid data.')
  }
  return `artifactshare-bridge-${[...bytes]
    .map((value) => value.toString(16).padStart(2, '0'))
    .join('')}`
}

function webRandomBytes(length: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(length))
}

function validateOrigin(value: string): string {
  const url = new URL(value)
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  if (
    (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) ||
    url.pathname !== '/' ||
    url.username !== '' ||
    url.password !== '' ||
    url.search !== '' ||
    url.hash !== ''
  ) {
    throw new TypeError('baseUrl must be an allowed absolute origin.')
  }
  return url.origin
}

function sameOriginUrl(value: unknown, baseUrl: string): boolean {
  if (!boundedString(value, 2048) || hasAsciiControl(value)) {
    return false
  }
  try {
    const url = new URL(value)
    return (
      url.origin === baseUrl &&
      url.protocol === new URL(baseUrl).protocol &&
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

function boundedString(value: unknown, max: number): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    isWellFormed(value) &&
    encoder.encode(value).byteLength <= max &&
    !hasAsciiControl(value)
  )
}

function boundedCharacters(value: unknown, max: number): value is string {
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

function boundedVisible(value: string): string {
  if (!boundedString(value, 200) || /[^\x20-\x7e]/.test(value)) {
    throw new TypeError('userAgent is invalid.')
  }
  return value
}

function integer(value: number, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new TypeError('Integer option is outside its allowed range.')
  }
  return value
}

function isAudience(value: unknown): value is RequestedAudience {
  return value === 'private' || value === 'workspace'
}
