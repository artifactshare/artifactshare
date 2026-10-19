import { beforeEach, expect, test, vi } from 'vitest'
const mocks = vi.hoisted(() => ({
  access: vi.fn(),
  write: vi.fn(),
  create: vi.fn(),
  page: vi.fn(),
}))
vi.mock('cloudflare:workers', () => ({ env: {} }))
vi.mock('~/middleware/auth', () => ({ requireUserApiMiddleware: vi.fn() }))
vi.mock('~/middleware/context', () => ({
  requireUser: () => ({ id: 'viewer' }),
  ctxContext: {},
}))
vi.mock('~/services/db.server', () => ({ createDb: () => ({}) }))
vi.mock('~/services/comments.server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('~/services/comments.server')>()),
  loadCommentAccess: mocks.access,
  storeAnchorResolutions: mocks.write,
  createCommentThread: mocks.create,
  loadCommentThreadPage: mocks.page,
}))
import { action, loader } from './api.shareables.$id.comments'
import { isAnchorResolution } from '~/services/comments.server'

const payload = {
  intent: 'anchor-resolutions',
  versionId: 'displayed-v1',
  targetPath: '/index.html',
  frameToken: 'a'.repeat(64),
  generation: 2,
  results: [
    {
      threadId: 'thread-1',
      state: 'attached',
      textStart: 0,
      textEnd: 4,
      textHash: 'b'.repeat(64),
    },
  ],
}
function post(body: unknown) {
  return action({
    request: new Request(
      'https://example.com/api/shareables/artifact/comments',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      },
    ),
    params: { id: 'artifact' },
    context: { get: () => ({ waitUntil: vi.fn() }) },
  } as unknown as Parameters<typeof action>[0])
}
beforeEach(() => {
  vi.clearAllMocks()
  mocks.access.mockResolvedValue({
    shareableId: 'artifact',
    currentVersionId: 'current-v3',
  })
  mocks.write.mockImplementation(async (_db, _access, input) =>
    input.results.every(isAnchorResolution),
  )
})
test('position-only writes preserve the displayed historical version and do not create comments', async () => {
  expect((await post(payload)).status).toBe(200)
  expect(mocks.write).toHaveBeenCalledWith(
    {},
    expect.anything(),
    expect.objectContaining({
      versionId: 'displayed-v1',
      targetPath: '/index.html',
      generation: 2,
    }),
  )
  expect(mocks.create).not.toHaveBeenCalled()
})
test('view authorization is required for write-back', async () => {
  mocks.access.mockResolvedValue(null)
  expect((await post(payload)).status).toBe(404)
  expect(mocks.write).not.toHaveBeenCalled()
})
test.each([
  { state: 'checking' },
  { textStart: -1 },
  { textHash: 'invalid' },
  { textEnd: 0 },
])('rejects malformed or transient results: %j', (patch) => {
  return post({
    ...payload,
    results: [{ ...payload.results[0], ...patch }],
  }).then((response) => {
    expect(response.status).toBe(400)
    expect(mocks.write).toHaveBeenCalledTimes(1)
  })
})
test('rejects cross-artifact or wrong-path results refused by storage', async () => {
  mocks.write.mockResolvedValue(false)
  expect((await post(payload)).status).toBe(400)
})
test('a stale selection uses the existing version_conflict response', async () => {
  mocks.create.mockResolvedValue({ kind: 'version-conflict' })
  const response = await post({
    intent: 'create-thread',
    body: 'Check',
    anchor: {
      selectorFormat: 'normalized-v1',
      versionId: 'displayed-v1',
      quotedText: 'word',
      prefixText: '',
      suffixText: '',
      textStart: 0,
      textEnd: 4,
      textHash: 'b'.repeat(64),
      ambiguousAtCreation: false,
      cssPath: null,
    },
  })
  expect(response.status).toBe(409)
  expect(await response.json()).toMatchObject({
    error: { code: 'version_conflict' },
  })
})

test('accepts the pre-deploy text selection payload as a legacy selector', async () => {
  mocks.create.mockResolvedValue({ kind: 'invalid-body' })
  const anchor = {
    quotedText: 'word',
    prefixText: 'before',
    suffixText: 'after',
    textStart: 999,
    textEnd: 1003,
    cssPath: null,
  }
  await post({ intent: 'create-thread', body: 'Check', anchor })
  expect(mocks.create).toHaveBeenCalledWith(
    expect.anything(),
    expect.anything(),
    expect.anything(),
    'Check',
    expect.objectContaining({ ...anchor, selectorFormat: undefined }),
    expect.anything(),
  )
})

test('browser posting returns durable retry timing and the capacity distinction', async () => {
  mocks.create.mockResolvedValue({
    kind: 'rate-limited',
    retry_after_seconds: 12,
    retry_at: '2026-10-20T00:01:00.000Z',
  })
  const limited = await post({ intent: 'create-thread', body: 'Unsent' })
  expect(limited.status).toBe(429)
  expect(limited.headers.get('Retry-After')).toBe('12')
  expect(await limited.json()).toMatchObject({
    error: { code: 'rate-limited', details: { retry_after_seconds: 12 } },
  })
  mocks.create.mockResolvedValue({ kind: 'thread-capacity' })
  const full = await post({ intent: 'create-thread', body: 'Unsent' })
  expect(full.status).toBe(409)
  expect(await full.json()).toMatchObject({
    error: { code: 'thread-capacity' },
  })
})

test('browser page reads check current access before cursor errors and load only the target', async () => {
  const get = () =>
    loader({
      request: new Request(
        'https://example.com/api/shareables/artifact/comments?thread_id=thread&before=cursor&limit=50',
      ),
      params: { id: 'artifact' },
      context: new Map(),
    } as never)
  mocks.access.mockResolvedValue(null)
  expect((await get()).status).toBe(404)
  expect(mocks.page).not.toHaveBeenCalled()
  mocks.access.mockResolvedValue({ shareableId: 'artifact' })
  mocks.page.mockResolvedValue({ kind: 'invalid-page' })
  expect((await get()).status).toBe(400)
  expect(mocks.page).toHaveBeenCalledWith(
    {},
    { shareableId: 'artifact' },
    { id: 'viewer' },
    'thread',
    {
      before: 'cursor',
      aroundMessageId: undefined,
      through: undefined,
      limit: 50,
    },
  )
})
