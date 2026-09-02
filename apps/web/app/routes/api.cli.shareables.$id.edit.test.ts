import { beforeEach, describe, expect, test, vi } from 'vitest'

const requireUserApiWithBearerMiddlewareMock = vi.hoisted(() => vi.fn())
const requireUserMock = vi.hoisted(() => vi.fn())
const createDbMock = vi.hoisted(() => vi.fn())
const editShareableSettingsMock = vi.hoisted(() => vi.fn())

vi.mock('~/middleware/auth', () => ({
  requireUserApiWithBearerMiddleware: requireUserApiWithBearerMiddlewareMock,
}))
vi.mock('~/middleware/context', () => ({
  getCliAuthority: () => null,
  requireUser: requireUserMock,
}))
vi.mock('~/services/db.server', () => ({
  createDb: createDbMock,
  withDb: (fn: (db: unknown) => unknown) => fn(createDbMock()),
}))
vi.mock('~/services/shareables.server', () => ({
  editShareableSettings: editShareableSettingsMock,
}))

import { action, middleware } from './api.cli.shareables.$id.edit'

describe('/api/cli/shareables/:id/edit', () => {
  beforeEach(() => {
    requireUserApiWithBearerMiddlewareMock.mockReset()
    requireUserMock.mockReset()
    createDbMock.mockReset()
    editShareableSettingsMock.mockReset()
    createDbMock.mockReturnValue({})
    requireUserMock.mockReturnValue({
      id: 'u1',
      email: 'owner@example.com',
      workspaceId: 'ws1',
      hd: 'example.com',
    })
    editShareableSettingsMock.mockResolvedValue({
      kind: 'ok',
      shareable: {
        id: 'abc123def4',
        title: 'Launch plan',
        visibility: 'workspace',
        updatedAt: '2026-06-18T00:00:00Z',
        projectId: 'prj1',
      },
    })
  })

  test('edits title, sharing, and destination for the authenticated owner', async () => {
    const response = await action({
      context: new Map(),
      params: { id: 'abc123def4' },
      request: new Request(
        'https://artifactshare.test/api/cli/shareables/abc123def4/edit',
        {
          method: 'POST',
          body: JSON.stringify({
            title: 'Launch plan',
            visibility: 'workspace',
            add_emails: ['viewer@example.com'],
            remove_emails: ['old@example.com'],
            destination: { project_id: ' prj1 ' },
          }),
        },
      ),
    } as never)
    const body = (await response.json()) as {
      artifact: { id: string; url: string }
      title: string
      destination: { type: string; project_id: string }
      share: { visibility: string }
    }

    expect(response.status).toBe(200)
    expect(editShareableSettingsMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ id: 'u1', workspaceId: 'ws1' }),
      'abc123def4',
      {
        title: 'Launch plan',
        visibility: 'workspace',
        addEmails: ['viewer@example.com'],
        removeEmails: ['old@example.com'],
        destination: { type: 'project', projectId: 'prj1' },
      },
      null,
    )
    expect(body).toEqual({
      artifact: {
        id: 'abc123def4',
        url: 'https://artifactshare.test/a/abc123def4',
      },
      title: 'Launch plan',
      destination: { type: 'project', project_id: 'prj1' },
      share: { visibility: 'workspace' },
    })
  })

  test('returns home destination for unfiled artifacts', async () => {
    editShareableSettingsMock.mockResolvedValue({
      kind: 'ok',
      shareable: {
        id: 'abc123def4',
        title: 'Backlog',
        visibility: 'private',
        updatedAt: '2026-06-18T00:00:00Z',
        projectId: null,
      },
    })

    const response = await action({
      context: new Map(),
      params: { id: 'abc123def4' },
      request: new Request(
        'https://artifactshare.test/api/cli/shareables/abc123def4/edit',
        { method: 'POST', body: JSON.stringify({ destination: 'home' }) },
      ),
    } as never)
    const body = (await response.json()) as {
      destination: { type: string; project_id: string | null }
    }

    expect(response.status).toBe(200)
    expect(body.destination).toEqual({ type: 'home', project_id: null })
  })

  test('returns not-found without leaking inaccessible shareables', async () => {
    editShareableSettingsMock.mockResolvedValue({ kind: 'not-found' })

    const response = await action({
      context: new Map(),
      params: { id: 'missing' },
      request: new Request(
        'https://artifactshare.test/api/cli/shareables/missing/edit',
        { method: 'POST', body: JSON.stringify({ title: 'Nope' }) },
      ),
    } as never)
    const body = (await response.json()) as { error: { code: string } }

    expect(response.status).toBe(404)
    expect(body.error.code).toBe('not-found')
  })

  test('returns invalid-destination for bad destinations', async () => {
    editShareableSettingsMock.mockResolvedValue({ kind: 'invalid-destination' })

    const response = await action({
      context: new Map(),
      params: { id: 'abc123def4' },
      request: new Request(
        'https://artifactshare.test/api/cli/shareables/abc123def4/edit',
        {
          method: 'POST',
          body: JSON.stringify({ destination: { project_id: 'missing' } }),
        },
      ),
    } as never)
    const body = (await response.json()) as { error: { code: string } }

    expect(response.status).toBe(400)
    expect(body.error.code).toBe('invalid-destination')
  })

  test.each([
    {
      kind: 'workspace-unavailable',
      status: 400,
      code: 'workspace-unavailable',
    },
    {
      kind: 'too-many-grants',
      limit: 50,
      status: 400,
      code: 'too-many-grants',
    },
    { kind: 'commit-failed', status: 502, code: 'commit-failed' },
  ])('maps $kind to $status', async (result) => {
    editShareableSettingsMock.mockResolvedValue(result)

    const response = await action({
      context: new Map(),
      params: { id: 'abc123def4' },
      request: new Request(
        'https://artifactshare.test/api/cli/shareables/abc123def4/edit',
        { method: 'POST', body: JSON.stringify({ visibility: 'workspace' }) },
      ),
    } as never)
    const body = (await response.json()) as { error: { code: string } }

    expect(response.status).toBe(result.status)
    expect(body.error.code).toBe(result.code)
  })

  test('rejects requests with no changes', async () => {
    const response = await action({
      context: new Map(),
      params: { id: 'abc123def4' },
      request: new Request(
        'https://artifactshare.test/api/cli/shareables/abc123def4/edit',
        { method: 'POST', body: JSON.stringify({}) },
      ),
    } as never)
    const body = (await response.json()) as { error: { code: string } }

    expect(response.status).toBe(400)
    expect(body.error.code).toBe('validation-failed')
    expect(editShareableSettingsMock).not.toHaveBeenCalled()
  })
})
