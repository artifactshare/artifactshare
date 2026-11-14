// Local review history: what a submitted batch asked for, the document as it
// was when the batch was sent, and the document as it was when the agent
// reported. Stored next to the annotation store, never sent anywhere.
import { createHash, randomUUID } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import type {
  PreviewAnchor,
  PreviewAnnotation,
  PreviewAnnotationBatch,
  PreviewDoneOutcome,
  PreviewThreadMessage,
} from './contract.js'

/** Larger documents keep their revision and size but not their content. */
export const PREVIEW_HISTORY_MAX_SNAPSHOT_BYTES = 2 * 1024 * 1024

export type PreviewHistorySnapshot =
  | { size: number; encoding: 'utf8' | 'base64'; content: string }
  | { size: number; omitted: 'too_large' }
  | { size: null; omitted: 'unreadable' }

export interface PreviewHistoryItem {
  thread: string
  generation: number
  comment: string
  anchor: PreviewAnchor
  /** Thread messages as they were when the batch was submitted. */
  messages: PreviewThreadMessage[]
}

export interface PreviewHistoryReport {
  reported_at: string
  /** The document revision when the agent reported these items. */
  revision: string
  /** `fixed` and `skipped` are the agent's own report. Neither records a
   * person's approval, and `skipped` does not mean the text was fine. */
  items: Array<{
    thread: string
    generation: number
    outcome: PreviewDoneOutcome
    note: string | null
    reported_by: 'agent'
  }>
}

export interface PreviewHistoryRecord {
  schema_version: 1
  batch_id: string
  file_name: string
  submitted_at: string
  before_revision: string
  items: PreviewHistoryItem[]
  reports: PreviewHistoryReport[]
  /** Set when every item in the batch has a report. */
  completed_at: string | null
  /** Revision at the last report; the "after" document. */
  after_revision: string | null
  snapshots: Record<string, PreviewHistorySnapshot>
}

export interface PreviewHistorySummary {
  batch_id: string
  file_name: string
  submitted_at: string
  completed_at: string | null
  items: number
  fixed: number
  skipped: number
  before_revision: string
  after_revision: string | null
}

export interface PreviewHistory {
  recordSubmission(
    batch: PreviewAnnotationBatch,
    annotations: PreviewAnnotation[],
    document: Buffer | null,
  ): void
  recordReport(
    batchId: string,
    items: PreviewHistoryReport['items'],
    completed: boolean,
    document: Buffer | null,
  ): void
  list(): PreviewHistorySummary[]
  read(batchId: string): PreviewHistoryRecord | null
}

function revisionOf(document: Buffer | null): string {
  return document === null
    ? 'unreadable'
    : createHash('sha256').update(document).digest('hex')
}

function snapshotOf(document: Buffer | null): PreviewHistorySnapshot {
  if (document === null) return { size: null, omitted: 'unreadable' }
  if (document.length > PREVIEW_HISTORY_MAX_SNAPSHOT_BYTES)
    return { size: document.length, omitted: 'too_large' }
  const text = document.toString('utf8')
  // Keep the exact bytes: text that does not round-trip is stored as base64.
  return Buffer.from(text, 'utf8').equals(document)
    ? { size: document.length, encoding: 'utf8', content: text }
    : {
        size: document.length,
        encoding: 'base64',
        content: document.toString('base64'),
      }
}

function isBatchId(value: string): boolean {
  return /^[0-9a-f-]{36}$/.test(value)
}

function isRecord(value: unknown): value is PreviewHistoryRecord {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return (
    record.schema_version === 1 &&
    typeof record.batch_id === 'string' &&
    typeof record.file_name === 'string' &&
    typeof record.submitted_at === 'string' &&
    typeof record.before_revision === 'string' &&
    Array.isArray(record.items) &&
    Array.isArray(record.reports) &&
    typeof record.snapshots === 'object' &&
    record.snapshots !== null
  )
}

export function createPreviewHistory(
  directory: string,
  fileName: string,
): PreviewHistory {
  function path(batchId: string): string {
    return join(directory, `${batchId}.json`)
  }

  function write(record: PreviewHistoryRecord): void {
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    const temp = join(directory, `.history-${randomUUID()}.tmp`)
    try {
      writeFileSync(temp, JSON.stringify(record, null, 2), { mode: 0o600 })
      chmodSync(temp, 0o600)
      renameSync(temp, path(record.batch_id))
    } catch (error) {
      try {
        rmSync(temp, { force: true })
      } catch {
        /* Preserve the write error. */
      }
      throw error
    }
  }

  function read(batchId: string): PreviewHistoryRecord | null {
    if (!isBatchId(batchId) || !existsSync(path(batchId))) return null
    try {
      const parsed: unknown = JSON.parse(readFileSync(path(batchId), 'utf8'))
      return isRecord(parsed) && parsed.batch_id === batchId ? parsed : null
    } catch {
      return null
    }
  }

  return {
    recordSubmission(batch, annotations, document) {
      const members = new Set(
        batch.members.map((member) => `${member.thread}:${member.generation}`),
      )
      const revision = revisionOf(document)
      write({
        schema_version: 1,
        batch_id: batch.id,
        file_name: fileName,
        submitted_at: batch.created_at,
        before_revision: revision,
        items: annotations
          .filter((annotation) =>
            members.has(`${annotation.thread}:${annotation.generation}`),
          )
          .map((annotation) => ({
            thread: annotation.thread,
            generation: annotation.generation,
            comment: annotation.comment,
            anchor: structuredClone(annotation.anchor),
            messages: structuredClone(annotation.messages),
          })),
        reports: [],
        completed_at: null,
        after_revision: null,
        snapshots: { [revision]: snapshotOf(document) },
      })
    },

    recordReport(batchId, items, completed, document) {
      const record = read(batchId)
      if (!record || items.length === 0) return
      const revision = revisionOf(document)
      const reportedAt = new Date().toISOString()
      record.reports.push({ reported_at: reportedAt, revision, items })
      record.after_revision = revision
      if (completed && record.completed_at === null)
        record.completed_at = reportedAt
      record.snapshots[revision] ??= snapshotOf(document)
      write(record)
    },

    list() {
      if (!existsSync(directory)) return []
      return readdirSync(directory)
        .filter((name) => name.endsWith('.json'))
        .map((name) => read(name.slice(0, -'.json'.length)))
        .filter((record): record is PreviewHistoryRecord => record !== null)
        .sort((a, b) => a.submitted_at.localeCompare(b.submitted_at))
        .map((record) => {
          const latest = new Map<string, PreviewDoneOutcome>()
          for (const report of record.reports)
            for (const item of report.items)
              latest.set(`${item.thread}:${item.generation}`, item.outcome)
          const outcomes = [...latest.values()]
          return {
            batch_id: record.batch_id,
            file_name: record.file_name,
            submitted_at: record.submitted_at,
            completed_at: record.completed_at,
            items: record.items.length,
            fixed: outcomes.filter((outcome) => outcome === 'fixed').length,
            skipped: outcomes.filter((outcome) => outcome === 'skipped').length,
            before_revision: record.before_revision,
            after_revision: record.after_revision,
          }
        })
    },

    read,
  }
}
