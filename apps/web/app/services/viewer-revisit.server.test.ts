import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { createViewerRevisitFixture } from '~/test/viewer-revisit-fixture'
import { loadViewerRevisitContext } from './viewer-revisit.server'
import { recordViewerRecency } from './views.server'

vi.mock('cloudflare:workers', () => ({ env: {} }))

const before = '2026-01-01T00:00:00.000Z'
const boundary = '2026-01-02T00:00:00.000Z'
const after = '2026-01-03T00:00:00.000Z'
const input = {
  shareableId: 's1',
  viewerUserId: 'u1',
  currentVersionId: 'v1',
  versions: [{ id: 'v1', ordinal: 1 }],
}
let fixture: ReturnType<typeof createViewerRevisitFixture>
beforeEach(() => {
  fixture = createViewerRevisitFixture()
})
afterEach(async () => {
  await fixture.db.destroy()
})

function thread(
  id: string,
  status = 'open',
  shareableId = 's1',
  updatedAt = after,
) {
  fixture.sqlite
    .prepare(
      'INSERT INTO comment_threads (id, shareable_id, status, created_by_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    )
    .run(id, shareableId, status, 'u2', before, updatedAt)
}
function message(
  id: string,
  threadId: string,
  createdAt = after,
  author = 'u2',
) {
  fixture.sqlite
    .prepare(
      'INSERT INTO comment_messages (id, thread_id, body, created_by_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    )
    .run(id, threadId, id, author, createdAt, createdAt)
}
const load = () => loadViewerRevisitContext(fixture.db, input)

describe('viewer revisit entry snapshot', () => {
  test('count and pairs share strict boundary, author, shareable and status eligibility', async () => {
    thread('thread-1')
    thread('thread-2', 'resolved')
    thread('thread-other', 'open', 's2')
    message('message-old', 'thread-1', before)
    message('message-equal', 'thread-1', boundary)
    message('message-own', 'thread-1', after, 'u1')
    message('message-other-file', 'thread-other')
    // Reverse insertion order proves deterministic ID tie ordering.
    message('message-2', 'thread-2')
    message('message-1', 'thread-1')
    expect(await load()).toEqual({
      entryCurrentVersionId: 'v1',
      version: null,
      commentCount: 2,
      newCommentMessages: [
        { messageId: 'message-1', threadId: 'thread-1' },
        { messageId: 'message-2', threadId: 'thread-2' },
      ],
    })
  })

  test('orders timestamps before IDs and does not infer newness from thread activity', async () => {
    thread('thread-1')
    message('message-a', 'thread-1', after)
    message('message-z', 'thread-1', '2026-01-02T12:00:00.000Z')
    expect(
      (await load())?.newCommentMessages.map((pair) => pair.messageId),
    ).toEqual(['message-z', 'message-a'])
  })

  test('null boundary counts all other-author messages, while missing recency has no context', async () => {
    thread('thread-1')
    message('message-old', 'thread-1', before)
    message('message-own', 'thread-1', after, 'u1')
    fixture.sqlite.exec(
      'UPDATE shareable_viewer_recency SET comment_seen_through_at = NULL',
    )
    expect(await load()).toMatchObject({
      commentCount: 1,
      newCommentMessages: [{ messageId: 'message-old', threadId: 'thread-1' }],
    })
    fixture.sqlite.exec('DELETE FROM shareable_viewer_recency')
    expect(await load()).toBeNull()
  })

  test('caps pairs at 100 without capping count and excludes the 51st thread', async () => {
    for (let index = 0; index < 50; index++)
      thread(`thread-${String(index).padStart(2, '0')}`)
    thread('thread-outside', 'resolved')
    message('message-outside', 'thread-outside')
    for (let index = 100; index >= 0; index--)
      message(`message-${String(index).padStart(3, '0')}`, 'thread-00')
    const result = await load()
    expect(result?.commentCount).toBe(101)
    expect(result?.newCommentMessages).toEqual(
      Array.from({ length: 100 }, (_, index) => ({
        messageId: `message-${String(index).padStart(3, '0')}`,
        threadId: 'thread-00',
      })),
    )
  })

  test('entry IDs survive the recency write; a later revisit has no comment markers', async () => {
    thread('thread-1')
    message('message-1', 'thread-1')
    const entry = await load()
    await recordViewerRecency(fixture.db, 's1', 'u1', {
      now: after,
      commentSeenThroughAt: after,
      versionSeenThroughAt: before,
    })
    expect(entry?.newCommentMessages).toEqual([
      { messageId: 'message-1', threadId: 'thread-1' },
    ])
    expect(await load()).toBeNull()
    fixture.sqlite.exec(
      'UPDATE shareable_viewer_recency SET version_seen_through_at = NULL',
    )
    expect(await load()).toEqual({
      entryCurrentVersionId: 'v1',
      version: { kind: 'fallback' },
      commentCount: 0,
      newCommentMessages: [],
    })
  })
})
