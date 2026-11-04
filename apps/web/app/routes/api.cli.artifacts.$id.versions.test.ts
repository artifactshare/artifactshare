import { beforeEach, expect, test, vi } from 'vitest'
const authority = vi.hoisted(() => vi.fn())
const authorize = vi.hoisted(() => vi.fn())
const history = vi.hoisted(() => vi.fn())
vi.mock('~/middleware/auth', () => ({
  requireUserApiWithBearerMiddleware: vi.fn(),
}))
vi.mock('~/middleware/context', () => ({
  requireUser: () => ({ id: 'u1', workspaceId: 'ws1' }),
  getCliAuthority: authority,
}))
vi.mock('~/services/db.server', () => ({
  withDb: (fn: (db: unknown) => unknown) => fn({}),
}))
vi.mock('~/services/agent-scope.server', () => ({
  authorizeAgentArtifactRead: authorize,
}))
vi.mock('~/services/artifact-versions.server', () => ({
  getArtifactVersions: history,
}))
import { loader } from './api.cli.artifacts.$id.versions'
const args = {
  context: new Map(),
  params: { id: 'abc123def4' },
  url: new URL(
    'https://example.com/api/cli/artifacts/abc123def4/versions?cursor=next',
  ),
} as never
beforeEach(() => {
  vi.clearAllMocks()
  authority.mockReturnValue(null)
})
test('human history forwards pagination and returns validated metadata', async () => {
  const data = {
    id: 'abc123def4',
    retain_versions: 3,
    version_count: 1,
    total_size_bytes: 42,
    versions: [],
    limit: 50,
    has_more: false,
    next_cursor: null,
  }
  history.mockResolvedValue({ kind: 'ok', data })
  const response = await loader(args)
  expect(response.status).toBe(200)
  expect(await response.json()).toEqual(data)
  expect(history).toHaveBeenCalledWith({}, expect.anything(), {
    id: 'abc123def4',
    cursor: 'next',
  })
})
test('publisher history remains scope denied', async () => {
  authority.mockReturnValue({ kind: 'publisher' })
  expect((await loader(args)).status).toBe(403)
  expect(history).not.toHaveBeenCalled()
})
test('agent denied and missing viewer retain 404 and 401 precedence', async () => {
  authority.mockReturnValue({ kind: 'agent' })
  for (const [kind, status] of [
    ['denied', 404],
    ['missing-viewer', 401],
  ]) {
    authorize.mockResolvedValue({ kind })
    expect((await loader(args)).status).toBe(status)
  }
  expect(history).not.toHaveBeenCalled()
})
test('authorized agent passes its resolved viewer to history', async () => {
  authority.mockReturnValue({ kind: 'agent' })
  authorize.mockResolvedValue({
    kind: 'authorized',
    authorization: { viewerWorkspaceId: 'ws1' },
  })
  history.mockResolvedValue({ kind: 'not-found' })
  const response = await loader(args)
  expect(response.status).toBe(404)
  expect(await response.json()).toMatchObject({ error: { code: 'not-found' } })
  expect(history).toHaveBeenCalledWith(
    {},
    expect.anything(),
    expect.objectContaining({
      agentReadAuthorization: { viewerWorkspaceId: 'ws1' },
    }),
  )
})
test('invalid cursor uses validation-failed with restart advice', async () => {
  history.mockResolvedValue({ kind: 'invalid-cursor' })
  const response = await loader(args)
  expect(response.status).toBe(400)
  expect(await response.json()).toMatchObject({
    error: {
      code: 'validation-failed',
      message: expect.stringContaining('Restart without --cursor'),
    },
  })
})
