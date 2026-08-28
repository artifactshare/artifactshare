import { randomUUID } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import type {
  PreviewAnchor,
  PreviewAnnotation,
  PreviewDoneItemInput,
  PreviewDoneItemResult,
  PreviewNextItem,
  PreviewThreadMessage,
} from './contract.js'

interface AnnotationsFile {
  schema_version: 1
  annotations: PreviewAnnotation[]
}

export type PreviewStoreError =
  | { ok: false; reason: 'unknown_thread' }
  | { ok: false; reason: 'invalid_status'; status: PreviewAnnotation['status'] }

export type PreviewStoreResult =
  | { ok: true; annotation: PreviewAnnotation }
  | PreviewStoreError

function nowIso(): string {
  return new Date().toISOString()
}

function isAnnotationsFile(value: unknown): value is AnnotationsFile {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return record.schema_version === 1 && Array.isArray(record.annotations)
}

export interface PreviewStore {
  /** Set when a corrupt annotations file was moved aside during load. */
  readonly quarantinedPath: string | null
  createDraft(anchor: PreviewAnchor, comment: string): PreviewAnnotation
  deleteDraft(thread: string): PreviewStoreResult
  discardAllDrafts(): PreviewAnnotation[]
  submitDrafts(): PreviewAnnotation[]
  deliver(): PreviewNextItem[]
  applyDone(items: PreviewDoneItemInput[]): PreviewDoneItemResult[]
  reply(
    thread: string,
    body: string,
    author: PreviewThreadMessage['author'],
  ): PreviewStoreResult
  reopen(thread: string): PreviewStoreResult
  setAnchorState(
    thread: string,
    state: 'attached' | 'orphaned',
  ): PreviewStoreResult
  unresolved(): PreviewAnnotation[]
  all(): PreviewAnnotation[]
}

export function createPreviewStore(annotationsPath: string): PreviewStore {
  let annotations: PreviewAnnotation[] = []
  let quarantined: string | null = null

  if (existsSync(annotationsPath)) {
    let parsed: unknown = null
    let valid = false
    try {
      parsed = JSON.parse(readFileSync(annotationsPath, 'utf8'))
      valid = isAnnotationsFile(parsed)
    } catch {
      valid = false
    }
    if (valid) {
      annotations = (parsed as AnnotationsFile).annotations
    } else {
      const stamp = nowIso().replaceAll(':', '')
      const target = `${annotationsPath}.corrupt-${stamp}`
      renameSync(annotationsPath, target)
      quarantined = target
    }
  }

  function save(): void {
    const payload: AnnotationsFile = { schema_version: 1, annotations }
    const dir = dirname(annotationsPath)
    mkdirSync(dir, { recursive: true })
    const temp = join(dir, `.annotations-${randomUUID()}.tmp`)
    writeFileSync(temp, JSON.stringify(payload, null, 2))
    renameSync(temp, annotationsPath)
  }

  function find(thread: string): PreviewAnnotation | undefined {
    return annotations.find((annotation) => annotation.thread === thread)
  }

  function touch(annotation: PreviewAnnotation): void {
    annotation.updated_at = nowIso()
  }

  function message(
    author: PreviewThreadMessage['author'],
    body: string,
  ): PreviewThreadMessage {
    return { id: randomUUID(), author, body, created_at: nowIso() }
  }

  return {
    get quarantinedPath() {
      return quarantined
    },

    createDraft(anchor, comment) {
      const created = nowIso()
      const annotation: PreviewAnnotation = {
        thread: randomUUID(),
        generation: 1,
        status: 'draft',
        anchor,
        comment,
        messages: [message('human', comment)],
        batch_id: null,
        created_at: created,
        updated_at: created,
        summary: null,
      }
      annotations.push(annotation)
      save()
      return annotation
    },

    deleteDraft(thread) {
      const annotation = find(thread)
      if (!annotation) return { ok: false, reason: 'unknown_thread' }
      if (annotation.status !== 'draft') {
        return {
          ok: false,
          reason: 'invalid_status',
          status: annotation.status,
        }
      }
      annotations = annotations.filter((entry) => entry.thread !== thread)
      save()
      return { ok: true, annotation }
    },

    discardAllDrafts() {
      const drafts = annotations.filter((entry) => entry.status === 'draft')
      if (drafts.length > 0) {
        annotations = annotations.filter((entry) => entry.status !== 'draft')
        save()
      }
      return drafts
    },

    submitDrafts() {
      const drafts = annotations.filter((entry) => entry.status === 'draft')
      if (drafts.length === 0) return []
      const batchId = randomUUID()
      for (const draft of drafts) {
        draft.status = 'requested'
        draft.batch_id = batchId
        touch(draft)
      }
      save()
      return drafts
    },

    deliver() {
      const pending = annotations.filter(
        (entry) =>
          entry.status === 'requested' || entry.status === 'in_progress',
      )
      let changed = false
      for (const entry of pending) {
        if (entry.status !== 'in_progress') {
          entry.status = 'in_progress'
          touch(entry)
          changed = true
        }
      }
      if (changed) save()
      return pending.map((entry) => ({
        thread: entry.thread,
        generation: entry.generation,
        batch_id: entry.batch_id ?? '',
        status: entry.status,
        anchor: entry.anchor,
        comment: entry.comment,
        messages: entry.messages,
      }))
    },

    applyDone(items) {
      const results: PreviewDoneItemResult[] = []
      let changed = false
      for (const item of items) {
        const annotation = find(item.thread)
        if (!annotation) {
          results.push('unknown_thread')
          continue
        }
        if (annotation.generation !== item.generation) {
          results.push('stale')
          continue
        }
        if (
          annotation.status === 'resolved' ||
          annotation.status === 'dismissed'
        ) {
          results.push('already_reported')
          continue
        }
        annotation.status = item.outcome === 'fixed' ? 'resolved' : 'dismissed'
        if (item.note !== undefined) {
          annotation.summary = item.note
          annotation.messages.push(message('agent', item.note))
        }
        touch(annotation)
        changed = true
        results.push('accepted')
      }
      if (changed) save()
      return results
    },

    reply(thread, body, author) {
      const annotation = find(thread)
      if (!annotation) return { ok: false, reason: 'unknown_thread' }
      annotation.messages.push(message(author, body))
      touch(annotation)
      save()
      return { ok: true, annotation }
    },

    reopen(thread) {
      const annotation = find(thread)
      if (!annotation) return { ok: false, reason: 'unknown_thread' }
      if (
        annotation.status !== 'resolved' &&
        annotation.status !== 'dismissed'
      ) {
        return {
          ok: false,
          reason: 'invalid_status',
          status: annotation.status,
        }
      }
      annotation.status = 'draft'
      annotation.generation += 1
      annotation.batch_id = null
      touch(annotation)
      save()
      return { ok: true, annotation }
    },

    setAnchorState(thread, state) {
      const annotation = find(thread)
      if (!annotation) return { ok: false, reason: 'unknown_thread' }
      if (annotation.anchor.kind !== 'artifact') {
        annotation.anchor = { ...annotation.anchor, state }
        touch(annotation)
        save()
      }
      return { ok: true, annotation }
    },

    unresolved() {
      return annotations.filter(
        (entry) => entry.status !== 'resolved' && entry.status !== 'dismissed',
      )
    },

    all() {
      return annotations
    },
  }
}
