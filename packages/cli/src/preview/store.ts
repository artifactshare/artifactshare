import { randomUUID } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import type {
  PreviewAgentFailureCode,
  PreviewAnchor,
  PreviewAnnotation,
  PreviewAnnotationBatch,
  PreviewDoneItemInput,
  PreviewDoneItemResult,
  PreviewNextItem,
  PreviewThreadMessage,
} from './contract.js'
import { isPreviewAnnotation } from './contract.js'

interface AnnotationsFileV1 {
  schema_version: 1
  annotations: PreviewAnnotation[]
}

interface AnnotationsFile {
  schema_version: 2
  annotations: PreviewAnnotation[]
  batches: PreviewAnnotationBatch[]
}

export type PreviewStoreError =
  | { ok: false; reason: 'unknown_thread' }
  | { ok: false; reason: 'invalid_status'; status: PreviewAnnotation['status'] }

export type PreviewStoreResult =
  | { ok: true; annotation: PreviewAnnotation }
  | PreviewStoreError

export type PreviewSubmitResult =
  | {
      ok: true
      annotations: PreviewAnnotation[]
      batch: PreviewAnnotationBatch | null
    }
  | { ok: false; reason: 'batch_in_progress'; batch: PreviewAnnotationBatch }

function nowIso(): string {
  return new Date().toISOString()
}

function isBatch(value: unknown): value is PreviewAnnotationBatch {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return (
    typeof record.id === 'string' &&
    Array.isArray(record.members) &&
    record.members.every((member) => {
      if (typeof member !== 'object' || member === null) return false
      const item = member as Record<string, unknown>
      return (
        typeof item.thread === 'string' &&
        Number.isInteger(item.generation) &&
        (item.terminal_result === null ||
          item.terminal_result === 'resolved' ||
          item.terminal_result === 'dismissed')
      )
    }) &&
    ['queued', 'processing', 'completed', 'failed', 'manual_required'].includes(
      String(record.state),
    ) &&
    (record.failure_code === null ||
      [
        'target_unavailable',
        'rejected',
        'timeout',
        'invalid_response',
        'adapter_error',
      ].includes(String(record.failure_code))) &&
    (record.retryable === null || typeof record.retryable === 'boolean') &&
    (record.dispatch_status === null ||
      record.dispatch_status === 'started' ||
      record.dispatch_status === 'accepted' ||
      record.dispatch_status === 'failed') &&
    typeof record.created_at === 'string' &&
    typeof record.updated_at === 'string'
  )
}

function isAnnotationsFile(value: unknown): value is AnnotationsFile {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  if (
    !(
      record.schema_version === 2 &&
      Array.isArray(record.annotations) &&
      record.annotations.every(isPreviewAnnotation) &&
      Array.isArray(record.batches) &&
      record.batches.every(isBatch)
    )
  ) {
    return false
  }
  const annotations = record.annotations as PreviewAnnotation[]
  const batches = record.batches as PreviewAnnotationBatch[]
  if (batches.filter((batch) => batch.state !== 'completed').length > 1) {
    return false
  }
  return annotations.every((annotation) => {
    if (
      annotation.status !== 'requested' &&
      annotation.status !== 'in_progress'
    ) {
      return true
    }
    const batch = batches.find(
      (candidate) => candidate.id === annotation.batch_id,
    )
    return batch?.members.some(
      (member) =>
        member.thread === annotation.thread &&
        member.generation === annotation.generation &&
        member.terminal_result === null,
    )
  })
}

function isAnnotationsFileV1(value: unknown): value is AnnotationsFileV1 {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return (
    record.schema_version === 1 &&
    Array.isArray(record.annotations) &&
    record.annotations.every(isPreviewAnnotation)
  )
}

export interface PreviewStore {
  readonly quarantinedPath: string | null
  createDraft(anchor: PreviewAnchor, comment: string): PreviewAnnotation
  deleteDraft(thread: string): PreviewStoreResult
  discardAllDrafts(): PreviewAnnotation[]
  submitDrafts(): PreviewSubmitResult
  deliver(): PreviewNextItem[]
  applyDone(items: PreviewDoneItemInput[]): PreviewDoneItemResult[]
  markManualRequired(batchId: string): void
  markDispatchStarted(batchId: string): void
  markDispatchAccepted(batchId: string): void
  markDispatchFailed(
    batchId: string,
    failureCode: PreviewAgentFailureCode,
    retryable: boolean,
  ): void
  recoverInterruptedBatch(): void
  activeBatch(): PreviewAnnotationBatch | null
  latestBatch(): PreviewAnnotationBatch | null
  batches(): PreviewAnnotationBatch[]
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
  let batches: PreviewAnnotationBatch[] = []
  let quarantined: string | null = null
  let migrated = false

  if (existsSync(annotationsPath)) {
    let parsed: unknown = null
    try {
      parsed = JSON.parse(readFileSync(annotationsPath, 'utf8'))
    } catch {
      parsed = null
    }
    if (isAnnotationsFile(parsed)) {
      annotations = parsed.annotations
      batches = parsed.batches
    } else if (isAnnotationsFileV1(parsed)) {
      annotations = parsed.annotations
      const grouped = new Map<string, PreviewAnnotation[]>()
      for (const annotation of annotations) {
        if (!annotation.batch_id) continue
        const current = grouped.get(annotation.batch_id) ?? []
        current.push(annotation)
        grouped.set(annotation.batch_id, current)
      }
      batches = [...grouped.entries()].map(([id, members]) => {
        const completed = members.every(
          (item) => item.status === 'resolved' || item.status === 'dismissed',
        )
        const processing = members.some((item) => item.status === 'in_progress')
        const created = members[0]?.created_at ?? nowIso()
        return {
          id,
          members: members.map((item) => ({
            thread: item.thread,
            generation: item.generation,
            terminal_result:
              item.status === 'resolved' || item.status === 'dismissed'
                ? item.status
                : null,
          })),
          state: completed
            ? 'completed'
            : processing
              ? 'processing'
              : 'manual_required',
          failure_code: null,
          retryable: null,
          dispatch_status: null,
          created_at: created,
          updated_at: members.at(-1)?.updated_at ?? created,
        }
      })
      migrated = true
    } else {
      const stamp = nowIso().replaceAll(':', '')
      const target = `${annotationsPath}.corrupt-${stamp}`
      renameSync(annotationsPath, target)
      quarantined = target
    }
  }

  function save(): void {
    const payload: AnnotationsFile = { schema_version: 2, annotations, batches }
    const dir = dirname(annotationsPath)
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    const temp = join(dir, `.annotations-${randomUUID()}.tmp`)
    writeFileSync(temp, JSON.stringify(payload, null, 2), { mode: 0o600 })
    renameSync(temp, annotationsPath)
    chmodSync(annotationsPath, 0o600)
  }

  if (migrated) save()

  function find(thread: string): PreviewAnnotation | undefined {
    return annotations.find((annotation) => annotation.thread === thread)
  }

  function findBatch(batchId: string): PreviewAnnotationBatch | undefined {
    return batches.find((batch) => batch.id === batchId)
  }

  function activeBatch(): PreviewAnnotationBatch | null {
    return (
      [...batches].reverse().find((batch) => batch.state !== 'completed') ??
      null
    )
  }

  function touch(annotation: PreviewAnnotation): void {
    annotation.updated_at = nowIso()
  }

  function touchBatch(batch: PreviewAnnotationBatch): void {
    batch.updated_at = nowIso()
  }

  function setBatchState(
    batchId: string,
    state: PreviewAnnotationBatch['state'],
    failureCode: PreviewAgentFailureCode | null = null,
    retryable: boolean | null = null,
  ): void {
    const batch = findBatch(batchId)
    if (!batch) return
    if (batch.state === 'processing' || batch.state === 'completed') return
    batch.state = state
    batch.failure_code = failureCode
    batch.retryable = retryable
    touchBatch(batch)
    save()
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
      const active = activeBatch()
      if (active)
        return { ok: false, reason: 'batch_in_progress', batch: active }
      const drafts = annotations.filter((entry) => entry.status === 'draft')
      if (drafts.length === 0) {
        return { ok: true, annotations: [], batch: null }
      }
      const batchId = randomUUID()
      const created = nowIso()
      for (const draft of drafts) {
        draft.status = 'requested'
        draft.batch_id = batchId
        touch(draft)
      }
      const batch: PreviewAnnotationBatch = {
        id: batchId,
        members: drafts.map((draft) => ({
          thread: draft.thread,
          generation: draft.generation,
          terminal_result: null,
        })),
        state: 'manual_required',
        failure_code: null,
        retryable: null,
        dispatch_status: null,
        created_at: created,
        updated_at: created,
      }
      batches.push(batch)
      save()
      return { ok: true, annotations: drafts, batch }
    },

    deliver() {
      const batch = activeBatch()
      if (!batch) return []
      const memberKeys = new Set(
        batch.members
          .filter((member) => member.terminal_result === null)
          .map((member) => `${member.thread}:${member.generation}`),
      )
      const pending = annotations.filter(
        (entry) =>
          memberKeys.has(`${entry.thread}:${entry.generation}`) &&
          (entry.status === 'requested' || entry.status === 'in_progress'),
      )
      let changed = false
      for (const entry of pending) {
        if (entry.status !== 'in_progress') {
          entry.status = 'in_progress'
          touch(entry)
          changed = true
        }
      }
      if (pending.length > 0 && batch.state !== 'processing') {
        batch.state = 'processing'
        batch.failure_code = null
        batch.retryable = null
        touchBatch(batch)
        changed = true
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
        const batch = annotation.batch_id
          ? findBatch(annotation.batch_id)
          : undefined
        const member = batch?.members.find(
          (candidate) =>
            candidate.thread === item.thread &&
            candidate.generation === item.generation,
        )
        if (!batch || !member) {
          results.push('stale')
          continue
        }
        const terminal = item.outcome === 'fixed' ? 'resolved' : 'dismissed'
        annotation.status = terminal
        member.terminal_result = terminal
        if (item.note !== undefined) {
          annotation.summary = item.note
          annotation.messages.push(message('agent', item.note))
        }
        touch(annotation)
        touchBatch(batch)
        if (
          batch.members.every((candidate) => candidate.terminal_result !== null)
        ) {
          batch.state = 'completed'
          batch.failure_code = null
          batch.retryable = null
        }
        changed = true
        results.push('accepted')
      }
      if (changed) save()
      return results
    },

    markManualRequired(batchId) {
      setBatchState(batchId, 'manual_required')
    },

    markDispatchStarted(batchId) {
      const batch = findBatch(batchId)
      if (!batch || batch.state === 'processing' || batch.state === 'completed')
        return
      batch.dispatch_status = 'started'
      batch.state = 'manual_required'
      batch.failure_code = null
      batch.retryable = null
      touchBatch(batch)
      save()
    },

    markDispatchAccepted(batchId) {
      const batch = findBatch(batchId)
      if (!batch) return
      batch.dispatch_status = 'accepted'
      if (batch.state !== 'processing' && batch.state !== 'completed') {
        batch.state = 'queued'
        batch.failure_code = null
        batch.retryable = null
      }
      touchBatch(batch)
      save()
    },

    markDispatchFailed(batchId, failureCode, retryable) {
      const batch = findBatch(batchId)
      if (!batch) return
      batch.dispatch_status = 'failed'
      if (batch.state !== 'processing' && batch.state !== 'completed') {
        batch.state = 'failed'
        batch.failure_code = failureCode
        batch.retryable = retryable
      }
      touchBatch(batch)
      save()
    },

    recoverInterruptedBatch() {
      const batch = activeBatch()
      if (!batch) return
      // Runtime registrations and their targets end with the server process.
      // A fetched batch may still be worked on, but every unclaimed batch must
      // require explicit pickup rather than inherit a stale queued/failed fact.
      if (batch.state !== 'processing') {
        batch.state = 'manual_required'
        batch.failure_code = null
        batch.retryable = null
        touchBatch(batch)
        save()
      }
    },

    activeBatch,

    latestBatch() {
      return batches.at(-1) ?? null
    },

    batches() {
      return batches
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
