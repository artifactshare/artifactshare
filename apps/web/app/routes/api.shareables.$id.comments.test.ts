import { beforeEach, expect, test, vi } from 'vitest'
const mocks = vi.hoisted(() => ({
  access: vi.fn(),
  write: vi.fn(),
  create: vi.fn(),
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
}))
import { action } from './api.shareables.$id.comments'
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
