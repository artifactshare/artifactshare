import { beforeEach, describe, expect, test, vi } from 'vitest'

const requireUserApiWithBearerMiddlewareMock = vi.hoisted(() => vi.fn())
const requireUserMock = vi.hoisted(() => vi.fn())
const createDbMock = vi.hoisted(() => vi.fn())
const changeCommentMock = vi.hoisted(() => vi.fn())
const loadCommentAccessMock = vi.hoisted(() => vi.fn())
const loadCommentThreadsMock = vi.hoisted(() => vi.fn())
const postArtifactCommentMock = vi.hoisted(() => vi.fn())
const ctxContextMock = vi.hoisted(() => ({}))

vi.mock('~/middleware/auth', () => ({
  requireUserApiWithBearerMiddleware: requireUserApiWithBearerMiddlewareMock,
}))
vi.mock('~/middleware/context', () => ({
  ctxContext: ctxContextMock,
  requireUser: requireUserMock,
}))
vi.mock('~/services/db.server', () => ({
  createDb: createDbMock,
  withDb: (fn: (db: unknown) => unknown) => fn(createDbMock()),
}))
vi.mock('~/services/comments.server', () => ({
  COMMENT_THREAD_LIST_LIMIT: 50,
  MAX_QUOTED_TEXT_LENGTH: 1000,
  MAX_CONTEXT_TEXT_LENGTH: 200,
  changeComment: changeCommentMock,
  loadCommentAccess: loadCommentAccessMock,
  loadCommentThreads: loadCommentThreadsMock,
  postArtifactComment: postArtifactCommentMock,
}))

import { action, loader, middleware } from './api.cli.artifacts.$id.comments'

const THREAD = {
  id: 'thr1',
  status: 'open' as const,
  subject: { kind: 'artifact' as const },
  createdAt: '2026-06-10T00:00:00.000Z',
  updatedAt: '2026-06-10T00:00:00.000Z',
  resolvedAt: null,
  canResolve: true,
  messages: [
    {
      id: 'msg1',
      body: 'First comment',
      agent: null,
      createdAt: '2026-06-10T00:00:00.000Z',
      updatedAt: '2026-06-10T00:00:00.000Z',
      author: {
        id: 'u1',
        name: 'Coji',
        email: 'owner@example.com',
        image: null,
      },
      canEdit: true,
      canDelete: true,
    },
  ],
}

const AGENT_THREAD = {
  id: 'thr1',
  status: 'open',
  resolved_at: null,
  created_at: '2026-06-10T00:00:00.000Z',
  updated_at: '2026-06-10T00:00:00.000Z',
  anchor: { kind: 'artifact', quoted_text: null, state: null },
  messages: [
    {
      message_id: 'msg1',
      author_name: 'Coji',
      author_email: 'owner@example.com',
      agent: null,
      body: 'First comment',
      created_at: '2026-06-10T00:00:00.000Z',
      updated_at: '2026-06-10T00:00:00.000Z',
    },
  ],
}

function postArgs(payload: unknown) {
  const waitUntil = vi.fn()
  return {
    context: new Map([[ctxContextMock, { waitUntil }]]),
    params: { id: 'abc123def4' },
    request: new Request(
      'https://example.com/api/cli/artifacts/abc123def4/comments',
      {
        method: 'POST',
        body: JSON.stringify(payload),
      },
    ),
  } as never
}

describe('/api/cli/artifacts/:id/comments', () => {
  beforeEach(() => {
    requireUserApiWithBearerMiddlewareMock.mockReset()
    requireUserMock.mockReset()
    createDbMock.mockReset()
    changeCommentMock.mockReset()
    loadCommentAccessMock.mockReset()
    loadCommentThreadsMock.mockReset()
    postArtifactCommentMock.mockReset()
    createDbMock.mockReturnValue({})
    requireUserMock.mockReturnValue({
      id: 'u1',
      email: 'owner@example.com',
      workspaceId: 'ws1',
      hd: 'example.com',
    })
    loadCommentAccessMock.mockResolvedValue({ shareableId: 'abc123def4' })
    loadCommentThreadsMock.mockResolvedValue([THREAD])
    changeCommentMock.mockResolvedValue({
      kind: 'ok',
      threadId: 'thr1',
      thread: THREAD,
      threads: [THREAD],
    })
  })

  test('loader returns the agent-shaped threads', async () => {
    const response = await loader({
      context: new Map(),
      params: { id: 'abc123def4' },
      request: new Request(
        'https://example.com/api/cli/artifacts/abc123def4/comments',
      ),
    } as never)
    const body = await response.json()

    expect(body).toEqual({
      artifact_id: 'abc123def4',
      share_url: 'https://example.com/a/abc123def4',
      comments: [AGENT_THREAD],
      has_more: false,
    })
  })

  test('loader hides non-viewable artifacts behind not-found', async () => {
    loadCommentAccessMock.mockResolvedValue(null)

    const response = await loader({
      context: new Map(),
      params: { id: 'abc123def4' },
      request: new Request(
        'https://example.com/api/cli/artifacts/abc123def4/comments',
      ),
    } as never)

    expect(response.status).toBe(404)
    const body = (await response.json()) as { error: { code: string } }
    expect(body.error.code).toBe('not-found')
  })

  test('action posts through the shared service and shapes the response', async () => {
    postArtifactCommentMock.mockResolvedValue({
      kind: 'ok',
      threadId: 'thr1',
      reply: false,
      thread: THREAD,
    })

    const response = await action(
      postArgs({
        body: 'Fix this',
        quote: 'exact text',
        quote_before: 'lead ',
        quote_after: ' tail',
      }),
    )
    const body = await response.json()

    expect(postArtifactCommentMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ id: 'u1' }),
      'abc123def4',
      {
        body: 'Fix this',
        replyTo: undefined,
        quote: 'exact text',
        quoteBefore: 'lead ',
        quoteAfter: ' tail',
      },
      expect.objectContaining({ waitUntil: expect.any(Function) }),
    )
    expect(body).toEqual({
      artifact_id: 'abc123def4',
      share_url: 'https://example.com/a/abc123def4',
      thread_id: 'thr1',
      reply: false,
      thread: AGENT_THREAD,
    })
  })

  test('action maps service failure kinds to stable codes', async () => {
    const cases = [
      { kind: 'quote-on-reply', status: 400, code: 'quote-on-reply' },
      { kind: 'quote-unsupported', status: 400, code: 'quote-unsupported' },
      { kind: 'quote-not-found', status: 400, code: 'quote-not-found' },
      { kind: 'closed-thread', status: 409, code: 'thread-resolved' },
      { kind: 'invalid-thread', status: 404, code: 'thread-not-found' },
      { kind: 'not-found', status: 404, code: 'not-found' },
      { kind: 'invalid-body', status: 400, code: 'invalid-comment' },
      { kind: 'commit-failed', status: 502, code: 'commit-failed' },
    ] as const

    for (const item of cases) {
      postArtifactCommentMock.mockResolvedValue({ kind: item.kind })
      const response = await action(
        postArgs({ body: 'Done', reply_to: 'thr1' }),
      )
      expect(response.status).toBe(item.status)
      const body = (await response.json()) as { error: { code: string } }
      expect(body.error.code).toBe(item.code)
    }
  })

  test('action rejects quote context without a quote', async () => {
    const response = await action(
      postArgs({ body: 'x', quote_before: 'lead ' }),
    )

    expect(response.status).toBe(400)
    const body = (await response.json()) as { error: { code: string } }
    expect(body.error.code).toBe('invalid-comment')
    expect(postArtifactCommentMock).not.toHaveBeenCalled()
  })

  test('action rejects an invalid payload before the service runs', async () => {
    const response = await action(postArgs({ body: '' }))

    expect(response.status).toBe(400)
    const body = (await response.json()) as { error: { code: string } }
    expect(body.error.code).toBe('invalid-comment')
    expect(postArtifactCommentMock).not.toHaveBeenCalled()
  })

  test('action rejects unknown action payloads instead of posting them', async () => {
    const response = await action(
      postArgs({ action: 'unknown', body: 'Would otherwise look like a post' }),
    )

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'invalid-comment' },
    })
    expect(postArtifactCommentMock).not.toHaveBeenCalled()
  })

  test('action edits a message through the shared service', async () => {
    const response = await action(
      postArgs({ action: 'edit', message_id: 'msg1', body: 'Updated' }),
    )
    const body = await response.json()

    expect(loadCommentAccessMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ id: 'u1' }),
      'abc123def4',
    )
    expect(changeCommentMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ shareableId: 'abc123def4' }),
      expect.objectContaining({ id: 'u1' }),
      { kind: 'update', messageId: 'msg1', body: 'Updated' },
      expect.objectContaining({ waitUntil: expect.any(Function) }),
    )
    expect(body).toEqual({
      artifact_id: 'abc123def4',
      share_url: 'https://example.com/a/abc123def4',
      thread_id: 'thr1',
      thread: AGENT_THREAD,
    })
  })

  test('action resolves and reopens a thread', async () => {
    const resolved = await action(
      postArgs({ action: 'resolve', thread_id: 'thr1' }),
    )
    expect(await resolved.json()).toMatchObject({
      thread_id: 'thr1',
      thread: AGENT_THREAD,
    })
    expect(changeCommentMock).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({ shareableId: 'abc123def4' }),
      expect.objectContaining({ id: 'u1' }),
      { kind: 'update', threadId: 'thr1', resolved: true },
      expect.objectContaining({ waitUntil: expect.any(Function) }),
    )

    await action(postArgs({ action: 'reopen', thread_id: 'thr1' }))
    expect(changeCommentMock).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({ shareableId: 'abc123def4' }),
      expect.objectContaining({ id: 'u1' }),
      { kind: 'update', threadId: 'thr1', resolved: false },
      expect.objectContaining({ waitUntil: expect.any(Function) }),
    )
  })

  test('action deletes a message only when it belongs to the thread', async () => {
    changeCommentMock.mockResolvedValue({
      kind: 'ok',
      threadId: 'thr1',
      deleted: true,
      threadDeleted: false,
      thread: THREAD,
      threads: [THREAD],
    })

    const response = await action(
      postArgs({ action: 'delete', thread_id: 'thr1', message_id: 'msg1' }),
    )
    const body = await response.json()

    expect(changeCommentMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ shareableId: 'abc123def4' }),
      expect.objectContaining({ id: 'u1' }),
      { kind: 'delete', threadId: 'thr1', messageId: 'msg1' },
      expect.objectContaining({ waitUntil: expect.any(Function) }),
    )
    expect(body).toEqual({
      artifact_id: 'abc123def4',
      share_url: 'https://example.com/a/abc123def4',
      thread_id: 'thr1',
      deleted: true,
      thread_deleted: false,
      thread: AGENT_THREAD,
    })

    changeCommentMock.mockResolvedValueOnce({ kind: 'invalid-message' })
    const mismatch = await action(
      postArgs({ action: 'delete', thread_id: 'thr1', message_id: 'msg1' }),
    )
    expect(mismatch.status).toBe(404)
    await expect(mismatch.json()).resolves.toMatchObject({
      error: { code: 'message-not-found' },
    })
  })

  test('action deletes a whole thread', async () => {
    changeCommentMock.mockResolvedValue({
      kind: 'ok',
      threadId: 'thr1',
      deleted: true,
      threadDeleted: true,
      threads: [],
    })

    const response = await action(
      postArgs({ action: 'delete', thread_id: 'thr1' }),
    )
    const body = await response.json()

    expect(changeCommentMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ shareableId: 'abc123def4' }),
      expect.objectContaining({ id: 'u1' }),
      { kind: 'delete', threadId: 'thr1' },
      expect.objectContaining({ waitUntil: expect.any(Function) }),
    )
    expect(body).toEqual({
      artifact_id: 'abc123def4',
      share_url: 'https://example.com/a/abc123def4',
      thread_id: 'thr1',
      deleted: true,
      thread_deleted: true,
    })
  })

  test('action maps comment action failures to stable codes', async () => {
    const cases = [
      { kind: 'invalid-message', status: 404, code: 'message-not-found' },
      { kind: 'invalid-thread', status: 404, code: 'thread-not-found' },
      { kind: 'forbidden', status: 403, code: 'forbidden' },
      { kind: 'invalid-body', status: 400, code: 'invalid-comment' },
      { kind: 'commit-failed', status: 502, code: 'commit-failed' },
    ] as const

    for (const item of cases) {
      changeCommentMock.mockResolvedValue({ kind: item.kind })
      const response = await action(
        postArgs({ action: 'edit', message_id: 'msg1', body: 'Updated' }),
      )
      expect(response.status).toBe(item.status)
      await expect(response.json()).resolves.toMatchObject({
        error: { code: item.code },
      })
    }
  })
})
