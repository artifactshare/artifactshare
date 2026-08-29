// Preview annotation contract - the single definition shared by the preview
// server, the injected browser UI, and the CLI verbs. Framework-neutral:
// no imports outside this module.

/** Anchor of an annotation inside the previewed document. */
export type PreviewAnchor =
  | { kind: 'artifact' }
  | {
      kind: 'text'
      state: 'attached' | 'orphaned'
      quotedText: string
      prefixText: string
      suffixText: string
      textStart: number | null
      textEnd: number | null
      cssPath: string | null
    }
  | {
      kind: 'element'
      state: 'attached' | 'orphaned'
      selector: string
      /** Human-readable label, e.g. `button "Submit"`. */
      label: string
      /** Nearby text captured at creation time, used for re-resolution. */
      contextText: string
      /** The element's own text and tag, which identify it after an edit far
       * more reliably than its positional selector. */
      ownText?: string
      tagName?: string
    }

export type PreviewAnnotationStatus =
  | 'draft'
  | 'requested'
  | 'in_progress'
  | 'resolved'
  | 'dismissed'

export type PreviewAgentCapability = 'push' | 'wait' | 'manual'

export type PreviewAgentState =
  | 'waiting'
  | 'queued'
  | 'processing'
  | 'completed'
  | 'failed'
  | 'manual_required'

export type PreviewAgentFailureCode =
  | 'target_unavailable'
  | 'rejected'
  | 'timeout'
  | 'invalid_response'
  | 'adapter_error'

/** Stored only in the private local session record. `target` is deliberately
 * absent from every browser and CLI projection. */
export interface PreviewAgentNotificationRegistration {
  provider: string
  transport: string
  capability: PreviewAgentCapability
  target: string | null
  registered_at: string
}

export interface PreviewAgentNotificationProjection {
  provider: string
  transport: string
  capability: PreviewAgentCapability
  state: PreviewAgentState
  failure_code?: PreviewAgentFailureCode
}

export interface PreviewBatchMember {
  thread: string
  generation: number
  terminal_result: 'resolved' | 'dismissed' | null
}

export type PreviewBatchDispatchStatus = 'started' | 'accepted' | 'failed'

export interface PreviewAnnotationBatch {
  id: string
  members: PreviewBatchMember[]
  state: Exclude<PreviewAgentState, 'waiting'>
  failure_code: PreviewAgentFailureCode | null
  retryable: boolean | null
  dispatch_status: PreviewBatchDispatchStatus | null
  created_at: string
  updated_at: string
}

export interface PreviewThreadMessage {
  id: string
  author: 'human' | 'agent'
  body: string
  created_at: string
}

export interface PreviewAnnotation {
  thread: string
  /** Incremented on reopen; stale generations are ignored by done. */
  generation: number
  status: PreviewAnnotationStatus
  anchor: PreviewAnchor
  comment: string
  messages: PreviewThreadMessage[]
  batch_id: string | null
  created_at: string
  updated_at: string
  /** Agent-provided summary shown on the thread (from the done note). */
  summary: string | null
}

export type PreviewDoneOutcome = 'fixed' | 'skipped'

export interface PreviewDoneItemInput {
  thread: string
  generation: number
  outcome: PreviewDoneOutcome
  note?: string
}

export type PreviewDoneItemResult =
  | 'accepted'
  | 'stale'
  | 'already_reported'
  | 'unknown_thread'

export interface PreviewNextItem {
  thread: string
  generation: number
  batch_id: string
  status: PreviewAnnotationStatus
  anchor: PreviewAnchor
  comment: string
  messages: PreviewThreadMessage[]
}

export interface PreviewNextResult {
  items: PreviewNextItem[]
  timed_out?: boolean
  session_ended?: boolean
  revision: string | null
  agent: PreviewAgentNotificationProjection
}

/** Custom header required on every mutating request. Its presence forces a
 * CORS preflight from any cross-origin caller, and the server sends no CORS
 * headers, so cross-origin writes fail in the browser. */
export const PREVIEW_MUTATION_HEADER = 'x-artifactshare-preview'
export const PREVIEW_MUTATION_HEADER_VALUE = '1'

/** Identification endpoint used for stale-session detection and reuse. */
export const PREVIEW_SESSION_ENDPOINT = '/__preview/session'

export interface PreviewSessionIdentity {
  service: 'artifactshare-preview'
  session_id: string
  realpath: string
  share_port: number
}

export function isPreviewSessionIdentity(
  value: unknown,
): value is PreviewSessionIdentity {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return (
    record.service === 'artifactshare-preview' &&
    typeof record.session_id === 'string' &&
    typeof record.realpath === 'string' &&
    typeof record.share_port === 'number'
  )
}

export function isPreviewDoneItemInput(
  value: unknown,
): value is PreviewDoneItemInput {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return (
    typeof record.thread === 'string' &&
    typeof record.generation === 'number' &&
    Number.isInteger(record.generation) &&
    (record.outcome === 'fixed' || record.outcome === 'skipped') &&
    (record.note === undefined || typeof record.note === 'string')
  )
}

const ANNOTATION_STATUSES = new Set([
  'draft',
  'requested',
  'in_progress',
  'resolved',
  'dismissed',
])

function isThreadMessage(value: unknown): value is PreviewThreadMessage {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return (
    typeof record.id === 'string' &&
    (record.author === 'human' || record.author === 'agent') &&
    typeof record.body === 'string' &&
    typeof record.created_at === 'string'
  )
}

/** A saved annotations file is quarantined rather than trusted, so every entry
 * has to be checked: one malformed record would otherwise crash rendering and
 * delivery with no way back. */
export function isPreviewAnnotation(
  value: unknown,
): value is PreviewAnnotation {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return (
    typeof record.thread === 'string' &&
    Number.isInteger(record.generation) &&
    typeof record.status === 'string' &&
    ANNOTATION_STATUSES.has(record.status) &&
    isPreviewAnchor(record.anchor) &&
    typeof record.comment === 'string' &&
    Array.isArray(record.messages) &&
    record.messages.every(isThreadMessage) &&
    (record.batch_id === null || typeof record.batch_id === 'string') &&
    typeof record.created_at === 'string' &&
    typeof record.updated_at === 'string' &&
    (record.summary === null || typeof record.summary === 'string')
  )
}

export function isPreviewAnchor(value: unknown): value is PreviewAnchor {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  if (record.kind === 'artifact') return true
  if (record.state !== 'attached' && record.state !== 'orphaned') {
    return false
  }
  const optionalString = (name: string): boolean =>
    record[name] === undefined || typeof record[name] === 'string'
  if (record.kind === 'element') {
    return (
      optionalString('ownText') &&
      optionalString('tagName') &&
      typeof record.selector === 'string' &&
      typeof record.label === 'string' &&
      typeof record.contextText === 'string'
    )
  }
  if (record.kind === 'text') {
    return (
      typeof record.quotedText === 'string' &&
      typeof record.prefixText === 'string' &&
      typeof record.suffixText === 'string' &&
      (record.textStart === null || Number.isInteger(record.textStart)) &&
      (record.textEnd === null || Number.isInteger(record.textEnd)) &&
      (record.cssPath === null || typeof record.cssPath === 'string')
    )
  }
  return false
}
