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
    }

export type PreviewAnnotationStatus =
  | 'draft'
  | 'requested'
  | 'in_progress'
  | 'resolved'
  | 'dismissed'

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

export function isPreviewAnchor(value: unknown): value is PreviewAnchor {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  if (record.kind === 'artifact') return true
  if (record.state !== 'attached' && record.state !== 'orphaned') {
    return false
  }
  if (record.kind === 'element') {
    return (
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
