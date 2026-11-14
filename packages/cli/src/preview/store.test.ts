import assert from 'node:assert/strict'
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test, vi } from 'vitest'
import { createPreviewStore } from './store.js'
import type { PreviewAnchor } from './contract.js'

vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs')>()
  return {
    ...fs,
    writeFileSync: vi.fn(fs.writeFileSync),
    renameSync: vi.fn(fs.renameSync),
    chmodSync: vi.fn(fs.chmodSync),
  }
})

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

test('a partial schema-2 submission is skipped instead of quarantining peers', () => {
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
  assert.equal(store.quarantinedPath, null)
  assert.equal(store.all().length, 0)
})

test('schema-1 migration coalesces multiple unfinished batches', () => {
  const path = storePath()
  const seed = createPreviewStore(path)
  const first = seed.createDraft(anchor, 'first legacy batch')
  const second = seed.createDraft(anchor, 'second legacy batch')
  const legacy = seed.all().map((annotation, index) => ({
    ...annotation,
    status: index === 0 ? 'in_progress' : 'requested',
    batch_id: index === 0 ? 'legacy-a' : 'legacy-b',
  }))
  writeFileSync(
    path,
    JSON.stringify({ schema_version: 1, annotations: legacy }),
  )

  const migrated = createPreviewStore(path)
  assert.equal(migrated.quarantinedPath, null)
  assert.equal(
    migrated.batches().filter((batch) => batch.state !== 'completed').length,
    1,
  )
  assert.deepEqual(
    new Set(migrated.activeBatch()?.members.map((member) => member.thread)),
    new Set([first.thread, second.thread]),
  )
  assert.equal(migrated.deliver().length, 2)

  const restarted = createPreviewStore(path)
  assert.equal(restarted.quarantinedPath, null)
  assert.equal(restarted.deliver().length, 2)
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

test('preserves modern selector metadata on reload and exposes position state without changing the quote', () => {
  const path = storePath()
  const store = createPreviewStore(path)
  const modern: PreviewAnchor = {
    ...anchor,
    selectorFormat: 'normalized-v1',
    textHash: 'a'.repeat(64),
    ambiguousAtCreation: true,
    position_state: 'attached',
  }
  const result = store.createDraft(modern, 'Check this')
  store.setAnchorState(result.thread, 'orphaned')
  const reloaded = createPreviewStore(path).all()[0]!
  assert.deepEqual(reloaded.anchor, {
    ...modern,
    state: 'orphaned',
    position_state: 'needs-check',
  })
})

for (const schema_version of [1, 2]) {
  test(`schema-${schema_version} keeps oversized legacy quotes and skips only malformed records`, () => {
    const path = storePath()
    const seed = createPreviewStore(path)
    const long = seed.createDraft(
      { ...anchor, quotedText: 'x'.repeat(1500), textEnd: 1500 },
      'old long selection',
    )
    const other = seed.createDraft(anchor, 'other')
    writeFileSync(
      path,
      JSON.stringify({
        schema_version,
        annotations: [long, { ...other, anchor: null }, other],
        batches: [],
      }),
    )
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const loaded = createPreviewStore(path)
      assert.equal(loaded.quarantinedPath, null)
      assert.deepEqual(
        loaded.all().map((record) => record.thread),
        [long.thread, other.thread],
      )
      assert.equal(warning.mock.calls.length, 1)
    } finally {
      warning.mockRestore()
    }
  })
}

for (const remaining of ['pending', 'resolved', 'none'] as const) {
  test(`recovers submitted batches after skipping a malformed member (${remaining} remains)`, () => {
    const path = storePath()
    const seed = createPreviewStore(path)
    const broken = seed.createDraft(anchor, 'will be corrupted')
    const kept =
      remaining === 'none' ? null : seed.createDraft(anchor, 'keep working')
    seed.submitDrafts()
    seed.deliver()
    if (remaining === 'resolved' && kept)
      seed.applyDone([{ thread: kept.thread, generation: 1, outcome: 'fixed' }])
    const saved = JSON.parse(readFileSync(path, 'utf8'))
    saved.annotations.find(
      (item: { thread: string }) => item.thread === broken.thread,
    ).anchor = null
    writeFileSync(path, JSON.stringify(saved))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const recovered = createPreviewStore(path)
      assert.equal(recovered.quarantinedPath, null)
      assert.equal(warn.mock.calls.length, 1)
      assert.deepEqual(
        recovered.latestBatch()?.members.map((member) => member.thread),
        kept ? [kept.thread] : [],
      )
      // Recovery is persisted even before another command mutates the store.
      const reloaded = createPreviewStore(path)
      // The skipped record is retained and reported again, never erased.
      assert.equal(warn.mock.calls.length, 2)
      assert.deepEqual(reloaded.batches(), recovered.batches())
      if (remaining === 'pending' && kept) {
        assert.deepEqual(
          reloaded.deliver().map((item) => item.thread),
          [kept.thread],
        )
        assert.deepEqual(
          reloaded.applyDone([
            { thread: kept.thread, generation: 1, outcome: 'fixed' },
          ]),
          ['accepted'],
        )
      } else {
        assert.deepEqual(reloaded.deliver(), [])
      }
      assert.equal(reloaded.latestBatch()?.state, 'completed')
      assert.equal(reloaded.activeBatch(), null)
      reloaded.createDraft(anchor, 'next request')
      assert.equal(reloaded.submitDrafts().ok, true)
    } finally {
      warn.mockRestore()
    }
  })
}

test('skipped annotations survive repeated load and save cycles unchanged', () => {
  const path = storePath()
  const seed = createPreviewStore(path)
  const draft = seed.createDraft(anchor, 'original')
  const skipped = [
    {
      ...draft,
      thread: 'missing-batch',
      status: 'requested',
      batch_id: 'missing',
    },
    {
      ...draft,
      thread: 'future-format',
      anchor: {
        ...anchor,
        selectorFormat: 'normalized-v99',
        futureData: ['preserve', 42],
      },
    },
    { thread: 'invalid', comment: 'preserve even incomplete records' },
  ]
  writeFileSync(
    path,
    JSON.stringify({
      schema_version: 2,
      annotations: [draft, ...skipped],
      batches: [],
    }),
  )
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  try {
    for (let cycle = 0; cycle < 2; cycle++) {
      const store = createPreviewStore(path)
      assert.equal(
        store.all().some((item) => item.thread === 'future-format'),
        false,
      )
      store.createDraft(anchor, 'new draft')
      const saved = JSON.parse(readFileSync(path, 'utf8'))
      for (const original of skipped) {
        assert.deepEqual(
          saved.annotations.find(
            (item: { thread: string }) => item.thread === original.thread,
          ),
          original,
        )
      }
    }
  } finally {
    warn.mockRestore()
  }
})

test.each([1, 2])(
  'schema %i preserves raw, textless and fingerprint element anchors without migration',
  (schema) => {
    const path = storePath()
    const store = createPreviewStore(path)
    const base = {
      kind: 'element' as const,
      state: 'attached' as const,
      selector: 'p',
      label: 'p',
      contextText: '',
      tagName: 'P',
    }
    const anchors: PreviewAnchor[] = [
      base,
      { ...base, ownText: '' },
      { ...base, ownText: 'a'.repeat(64) },
      { ...base, ownText: 'x'.repeat(1_100_000) },
      {
        ...base,
        ownTextHash: 'b'.repeat(64),
        ownTextExcerpt: 'x'.repeat(16000),
      },
    ]
    for (const value of anchors) store.createDraft(value, 'Review')
    const saved = JSON.parse(readFileSync(path, 'utf8'))
    saved.schema_version = schema
    writeFileSync(path, JSON.stringify(saved))
    const reopened = createPreviewStore(path)
    assert.equal(reopened.quarantinedPath, null)
    assert.deepEqual(
      reopened.all().map((annotation) => annotation.anchor),
      anchors,
    )
  },
)

test('a failed draft write rolls back before a successful retry', () => {
  const path = storePath()
  const store = createPreviewStore(path)
  const write = vi.mocked(writeFileSync).mockImplementationOnce(() => {
    throw new Error('write failed')
  })
  try {
    assert.throws(() => store.createDraft(anchor, 'Retry me'), /write failed/)
    assert.equal(store.all().length, 0)
    const saved = store.createDraft(anchor, 'Retry me')
    assert.deepEqual(store.all(), [saved])
    assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')).annotations, [
      saved,
    ])
  } finally {
    write.mockRestore()
  }
})

// Real files exercise replacement and reopen; syscall faults are deterministic
// even when the runner can bypass directory permission bits.
test.each([
  'create',
  'delete',
  'discard',
  'submit',
  'deliver',
  'done',
  'manual',
  'started',
  'accepted',
  'failed',
  'recovery',
  'reply',
  'reopen',
  'anchor',
])(
  '%s preserves committed and escaped state on pre-commit failure, then retries',
  (operation) => {
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      for (const syscall of [writeFileSync, chmodSync, renameSync]) {
        const path = storePath()
        const store = createPreviewStore(path)
        const draft = store.createDraft(anchor, 'Preserve this comment')
        const thread = draft.thread
        if (
          [
            'deliver',
            'done',
            'manual',
            'started',
            'accepted',
            'failed',
            'recovery',
            'reopen',
          ].includes(operation)
        )
          store.submitDrafts()
        const batchId = store.latestBatch()?.id ?? ''
        if (['manual', 'recovery'].includes(operation))
          store.markDispatchStarted(batchId)
        if (operation === 'reopen')
          store.applyDone([{ thread, generation: 1, outcome: 'fixed' }])
        const mutate = () => {
          switch (operation) {
            case 'create':
              return store.createDraft(anchor, 'Another comment')
            case 'delete':
              return store.deleteDraft(thread)
            case 'discard':
              return store.discardAllDrafts()
            case 'submit':
              return store.submitDrafts()
            case 'deliver':
              return store.deliver()
            case 'done':
              return store.applyDone([
                { thread, generation: 1, outcome: 'fixed', note: 'Fixed' },
              ])
            case 'manual':
              return store.markManualRequired(batchId)
            case 'started':
              return store.markDispatchStarted(batchId)
            case 'accepted':
              return store.markDispatchAccepted(batchId)
            case 'failed':
              return store.markDispatchFailed(
                batchId,
                'target_unavailable',
                true,
              )
            case 'recovery':
              return store.recoverInterruptedBatch()
            case 'reply':
              return store.reply(thread, 'More detail', 'human')
            case 'reopen':
              return store.reopen(thread)
            case 'anchor':
              return store.setAnchorState(thread, 'orphaned')
          }
        }
        const escaped = { annotations: store.all(), batches: store.batches() }
        const before = structuredClone(escaped)
        const bytes = readFileSync(path, 'utf8')
        // A failed touch must preserve timestamps even for escaped records.
        vi.setSystemTime(Date.now() + 1000)
        vi.mocked(syscall).mockImplementationOnce(() => {
          throw new Error('pre-commit fault')
        })
        assert.throws(mutate, /pre-commit fault/)
        assert.deepEqual(escaped, before)
        assert.deepEqual(
          { annotations: store.all(), batches: store.batches() },
          before,
        )
        assert.equal(readFileSync(path, 'utf8'), bytes)
        const reopened = createPreviewStore(path)
        assert.deepEqual(
          { annotations: reopened.all(), batches: reopened.batches() },
          before,
        )
        assert.deepEqual(readdirSync(dirname(path)), ['annotations.json'])
        mutate()
        assert.notEqual(readFileSync(path, 'utf8'), bytes)
        const retried = createPreviewStore(path)
        assert.deepEqual(retried.all(), store.all())
        assert.deepEqual(retried.batches(), store.batches())
        assert.equal(statSync(path).mode & 0o777, 0o600)
        rmSync(dirname(path), { recursive: true })
      }
    } finally {
      vi.useRealTimers()
    }
  },
)

test('blocked parent delete keeps the saved comment in memory and on disk', () => {
  const path = storePath()
  const dir = dirname(path)
  const moved = dir + '-moved'
  const store = createPreviewStore(path)
  const draft = store.createDraft(anchor, 'Keep me')
  const bytes = readFileSync(path, 'utf8')
  renameSync(dir, moved)
  writeFileSync(dir, 'blocked')
  try {
    assert.throws(() => store.deleteDraft(draft.thread))
    assert.deepEqual(store.all(), [draft])
    assert.equal(readFileSync(join(moved, 'annotations.json'), 'utf8'), bytes)
  } finally {
    rmSync(dir)
    renameSync(moved, dir)
  }
  store.deleteDraft(draft.thread)
  assert.deepEqual(createPreviewStore(path).all(), [])
  rmSync(dir, { recursive: true })
})
