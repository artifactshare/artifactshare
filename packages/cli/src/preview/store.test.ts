import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'vitest'
import { createPreviewStore } from './store.js'
import type { PreviewAnchor } from './contract.js'

const anchor: PreviewAnchor = {
  kind: 'text',
  state: 'attached',
  quotedText: 'hello',
  prefixText: '',
  suffixText: '',
  textStart: 0,
  textEnd: 5,
  cssPath: null,
}

function storePath(): string {
  return join(mkdtempSync(join(tmpdir(), 'preview-store-')), 'annotations.json')
}

test('a corrupt annotations file is quarantined and the store starts empty', () => {
  const path = storePath()
  writeFileSync(path, '{ not json')
  const store = createPreviewStore(path)
  assert.ok(store.quarantinedPath)
  assert.match(store.quarantinedPath ?? '', /annotations\.json\.corrupt-/)
  assert.equal(store.all().length, 0)
  const rescued = readFileSync(store.quarantinedPath ?? '', 'utf8')
  assert.equal(rescued, '{ not json')
})

test('an invalid schema is quarantined too', () => {
  const path = storePath()
  writeFileSync(path, JSON.stringify({ schema_version: 3, annotations: [] }))
  const store = createPreviewStore(path)
  assert.ok(store.quarantinedPath)
})

test('a partial schema-2 submission is quarantined instead of stranded', () => {
  const path = storePath()
  const created = new Date().toISOString()
  writeFileSync(
    path,
    JSON.stringify({
      schema_version: 2,
      annotations: [
        {
          thread: 'thread-1',
          generation: 1,
          status: 'requested',
          anchor: { kind: 'artifact' },
          comment: 'orphaned request',
          messages: [],
          batch_id: 'missing-batch',
          created_at: created,
          updated_at: created,
          summary: null,
        },
      ],
      batches: [],
    }),
  )
  const store = createPreviewStore(path)
  assert.ok(store.quarantinedPath)
  assert.equal(store.all().length, 0)
})

test('writes are atomic: the file parses after every mutation', () => {
  const path = storePath()
  const store = createPreviewStore(path)
  assert.equal(store.quarantinedPath, null)
  store.createDraft(anchor, 'first')
  const before = JSON.parse(readFileSync(path, 'utf8'))
  assert.equal(before.schema_version, 2)
  assert.equal(before.annotations.length, 1)
  assert.equal(statSync(path).mode & 0o777, 0o600)
  store.createDraft(anchor, 'second')
  const after = JSON.parse(readFileSync(path, 'utf8'))
  assert.equal(after.annotations.length, 2)
})

test('submit atomically stores fixed membership and rejects a second active batch', () => {
  const path = storePath()
  const store = createPreviewStore(path)
  const first = store.createDraft(anchor, 'first')
  const submitted = store.submitDrafts()
  assert.ok(submitted.ok && submitted.batch)
  const persisted = JSON.parse(readFileSync(path, 'utf8'))
  assert.deepEqual(persisted.batches[0].members, [
    { thread: first.thread, generation: 1, terminal_result: null },
  ])
  assert.equal(persisted.annotations[0].batch_id, persisted.batches[0].id)

  store.createDraft(anchor, 'later')
  const conflict = store.submitDrafts()
  assert.equal(conflict.ok, false)
  assert.equal(
    store.all().find((item) => item.comment === 'later')?.status,
    'draft',
  )
})

test('partial done and reopen retain the old generation terminal result', () => {
  const store = createPreviewStore(storePath())
  const first = store.createDraft(anchor, 'first')
  const second = store.createDraft(anchor, 'second')
  store.submitDrafts()
  store.deliver()
  assert.deepEqual(
    store.applyDone([
      { thread: first.thread, generation: 1, outcome: 'fixed' },
    ]),
    ['accepted'],
  )
  assert.ok(store.reopen(first.thread).ok)
  const batch = store.activeBatch()
  assert.ok(batch)
  assert.equal(
    batch?.members.find((member) => member.thread === first.thread)
      ?.terminal_result,
    'resolved',
  )
  assert.deepEqual(
    store.applyDone([
      { thread: second.thread, generation: 1, outcome: 'fixed' },
    ]),
    ['accepted'],
  )
  assert.equal(store.latestBatch()?.state, 'completed')
})

test('restart makes unclaimed notification results manual but preserves processing', () => {
  const path = storePath()
  const first = createPreviewStore(path)
  first.createDraft(anchor, 'queued before restart')
  const submitted = first.submitDrafts()
  assert.ok(submitted.ok && submitted.batch)
  if (!submitted.ok || !submitted.batch) throw new Error('submission failed')
  first.markDispatchAccepted(submitted.batch.id)

  const restarted = createPreviewStore(path)
  restarted.recoverInterruptedBatch()
  assert.equal(restarted.activeBatch()?.state, 'manual_required')
  restarted.deliver()

  const processingRestart = createPreviewStore(path)
  processingRestart.recoverInterruptedBatch()
  assert.equal(processingRestart.activeBatch()?.state, 'processing')
})

test('a store reloads persisted annotations', () => {
  const path = storePath()
  const first = createPreviewStore(path)
  const draft = first.createDraft(anchor, 'persist me')
  const second = createPreviewStore(path)
  assert.equal(second.all().length, 1)
  assert.equal(second.all()[0]?.thread, draft.thread)
})

test('draft -> submit -> deliver -> done round trip', () => {
  const store = createPreviewStore(storePath())
  const draft = store.createDraft(anchor, 'fix the heading')
  assert.equal(draft.status, 'draft')
  assert.equal(draft.generation, 1)
  assert.equal(draft.messages[0]?.author, 'human')

  const submitted = store.submitDrafts()
  assert.ok(submitted.ok)
  if (!submitted.ok) throw new Error('submission failed')
  assert.equal(submitted.annotations.length, 1)
  assert.equal(submitted.annotations[0]?.status, 'requested')
  assert.ok(submitted.annotations[0]?.batch_id)

  const delivered = store.deliver()
  assert.equal(delivered.length, 1)
  assert.equal(delivered[0]?.status, 'in_progress')
  assert.equal(delivered[0]?.batch_id, submitted.annotations[0]?.batch_id)

  // deliver is idempotent and keeps undone items in the feed
  const redelivered = store.deliver()
  assert.equal(redelivered.length, 1)
  assert.equal(redelivered[0]?.status, 'in_progress')

  const results = store.applyDone([
    { thread: draft.thread, generation: 1, outcome: 'fixed', note: 'done' },
  ])
  assert.deepEqual(results, ['accepted'])
  const annotation = store.all()[0]
  assert.equal(annotation?.status, 'resolved')
  assert.equal(annotation?.summary, 'done')
  assert.equal(annotation?.messages.at(-1)?.author, 'agent')
  assert.equal(annotation?.messages.at(-1)?.body, 'done')
  assert.equal(store.deliver().length, 0)
  assert.equal(store.unresolved().length, 0)
})

test('skipped outcome dismisses without requiring a note', () => {
  const store = createPreviewStore(storePath())
  const draft = store.createDraft(anchor, 'nit')
  store.submitDrafts()
  store.deliver()
  const results = store.applyDone([
    { thread: draft.thread, generation: 1, outcome: 'skipped' },
  ])
  assert.deepEqual(results, ['accepted'])
  assert.equal(store.all()[0]?.status, 'dismissed')
  assert.equal(store.all()[0]?.summary, null)
})

test('done reports stale, already_reported, and unknown_thread', () => {
  const store = createPreviewStore(storePath())
  const draft = store.createDraft(anchor, 'check me')
  store.submitDrafts()
  store.deliver()
  assert.deepEqual(
    store.applyDone([
      { thread: draft.thread, generation: 99, outcome: 'fixed' },
    ]),
    ['stale'],
  )
  assert.deepEqual(
    store.applyDone([
      { thread: draft.thread, generation: 1, outcome: 'fixed' },
    ]),
    ['accepted'],
  )
  // resending the same report is idempotent
  assert.deepEqual(
    store.applyDone([
      { thread: draft.thread, generation: 1, outcome: 'fixed' },
    ]),
    ['already_reported'],
  )
  assert.deepEqual(
    store.applyDone([{ thread: 'nope', generation: 1, outcome: 'fixed' }]),
    ['unknown_thread'],
  )
})

test('reopen bumps the generation and stales old done reports', () => {
  const store = createPreviewStore(storePath())
  const draft = store.createDraft(anchor, 'again')
  store.submitDrafts()
  store.deliver()
  store.applyDone([{ thread: draft.thread, generation: 1, outcome: 'fixed' }])

  const reopened = store.reopen(draft.thread)
  assert.ok(reopened.ok)
  if (reopened.ok) {
    assert.equal(reopened.annotation.status, 'draft')
    assert.equal(reopened.annotation.generation, 2)
  }
  // the old generation now reads stale
  assert.deepEqual(
    store.applyDone([
      { thread: draft.thread, generation: 1, outcome: 'fixed' },
    ]),
    ['stale'],
  )
  // a draft cannot be reopened
  const again = store.reopen(draft.thread)
  assert.equal(again.ok, false)
})

test('discardAllDrafts leaves non-drafts untouched', () => {
  const store = createPreviewStore(storePath())
  const submitted = store.createDraft(anchor, 'submitted one')
  store.submitDrafts()
  store.createDraft(anchor, 'draft one')
  store.createDraft(anchor, 'draft two')
  const discarded = store.discardAllDrafts()
  assert.equal(discarded.length, 2)
  assert.equal(store.all().length, 1)
  assert.equal(store.all()[0]?.thread, submitted.thread)
  assert.equal(store.all()[0]?.status, 'requested')
})

test('deleteDraft rejects non-drafts and unknown threads', () => {
  const store = createPreviewStore(storePath())
  const draft = store.createDraft(anchor, 'to submit')
  store.submitDrafts()
  const nonDraft = store.deleteDraft(draft.thread)
  assert.equal(nonDraft.ok, false)
  const unknown = store.deleteDraft('nope')
  assert.equal(unknown.ok, false)
  const fresh = store.createDraft(anchor, 'to delete')
  assert.equal(store.deleteDraft(fresh.thread).ok, true)
  assert.equal(store.all().length, 1)
})

test('reply appends a message without touching status or generation', () => {
  const store = createPreviewStore(storePath())
  const draft = store.createDraft(anchor, 'hi')
  const result = store.reply(draft.thread, 'more detail', 'human')
  assert.ok(result.ok)
  const annotation = store.all()[0]
  assert.equal(annotation?.messages.length, 2)
  assert.equal(annotation?.status, 'draft')
  assert.equal(annotation?.generation, 1)
  assert.equal(store.reply('nope', 'x', 'agent').ok, false)
})

test('setAnchorState flips attached/orphaned and no-ops on artifact anchors', () => {
  const store = createPreviewStore(storePath())
  const draft = store.createDraft(anchor, 'text anchored')
  const orphaned = store.setAnchorState(draft.thread, 'orphaned')
  assert.ok(orphaned.ok)
  const stored = store.all()[0]?.anchor
  assert.equal(stored?.kind === 'text' ? stored.state : null, 'orphaned')

  const artifactDraft = store.createDraft({ kind: 'artifact' }, 'whole doc')
  const noop = store.setAnchorState(artifactDraft.thread, 'orphaned')
  assert.ok(noop.ok)
  assert.deepEqual(store.all()[1]?.anchor, { kind: 'artifact' })
})
