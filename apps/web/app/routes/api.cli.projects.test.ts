import { beforeEach, describe, expect, test, vi } from 'vitest'

const requireUserApiWithBearerMiddlewareMock = vi.hoisted(() => vi.fn())
const requireUserMock = vi.hoisted(() => vi.fn())
const getCliAuthorityMock = vi.hoisted(() => vi.fn())
const createDbMock = vi.hoisted(() => vi.fn())
const checkUploadAccessMock = vi.hoisted(() => vi.fn())
const createProjectContainerMock = vi.hoisted(() => vi.fn())
const listWorkspaceProjectsMock = vi.hoisted(() => vi.fn())

vi.mock('cloudflare:workers', () => ({ env: {} }))
vi.mock('~/middleware/auth', () => ({
  requireUserApiWithBearerMiddleware: requireUserApiWithBearerMiddlewareMock,
}))
vi.mock('~/middleware/context', () => ({
  requireUser: requireUserMock,
  getCliAuthority: getCliAuthorityMock,
}))
vi.mock('~/services/db.server', () => ({
  createDb: createDbMock,
  withDb: (fn: (db: unknown) => unknown) => fn(createDbMock()),
}))
vi.mock('~/services/projects.server', async () => {
  const actual = await vi.importActual<
    typeof import('~/services/projects.server')
  >('~/services/projects.server')
  return {
    ...actual,
    createProjectContainer: createProjectContainerMock,
    listWorkspaceProjects: listWorkspaceProjectsMock,
  }
})
vi.mock('~/services/upload-access.server', () => ({
  checkUploadAccess: checkUploadAccessMock,
}))

import { action, loader } from './api.cli.projects'

describe('/api/cli/projects', () => {
  beforeEach(() => {
    requireUserMock.mockReset()
    getCliAuthorityMock.mockReset()
    getCliAuthorityMock.mockReturnValue(null)
    createDbMock.mockReset()
    checkUploadAccessMock.mockReset()
    createProjectContainerMock.mockReset()
    listWorkspaceProjectsMock.mockReset()
    createDbMock.mockReturnValue({})
    checkUploadAccessMock.mockResolvedValue({ kind: 'allowed' })
    createProjectContainerMock.mockResolvedValue({ kind: 'ok', id: 'prj_new' })
    requireUserMock.mockReturnValue({
      id: 'u1',
      email: 'owner@example.com',
      workspaceId: 'ws1',
      hd: 'example.com',
    })
  })

  test('returns the viewer-scoped workspace projects', async () => {
    listWorkspaceProjectsMock.mockResolvedValue([
      {
        id: 'prj1',
        name: 'Launch review',
        description: null,
        baseVisibility: 'workspace',
        fileCount: 3,
        updatedAt: '2026-06-09T00:00:00.000Z',
      },
    ])

    const response = await loader({ context: new Map() } as never)
    const body = (await response.json()) as { projects: unknown[] }

    expect(listWorkspaceProjectsMock).toHaveBeenCalledWith(
      expect.anything(),
      'ws1',
      expect.objectContaining({ id: 'u1', email: 'owner@example.com' }),
    )
    expect(body.projects).toEqual([
      {
        id: 'prj1',
        name: 'Launch review',
        description: null,
        base_visibility: 'workspace',
        file_count: 3,
        updated_at: '2026-06-09T00:00:00.000Z',
      },
    ])
  })

  test('creates a project for the authenticated workspace', async () => {
    const response = await action({
      context: new Map(),
      request: new Request('https://artifactshare.test/api/cli/projects', {
        method: 'POST',
        body: JSON.stringify({
          name: ' Client reports ',
          description: ' Weekly ',
          base_visibility: 'private',
        }),
      }),
    } as never)
    const body = (await response.json()) as {
      project: {
        id: string
        name: string
        description: string
        base_visibility: string
      }
    }

    expect(response.status).toBe(200)
    expect(checkUploadAccessMock).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'u1', workspaceId: 'ws1' }),
    )
    expect(createProjectContainerMock).toHaveBeenCalledWith(
      expect.anything(),
      'ws1',
      'u1',
      {
        name: 'Client reports',
        description: 'Weekly',
        baseVisibility: 'private',
      },
    )
    expect(body.project).toEqual({
      id: 'prj_new',
      name: 'Client reports',
      description: 'Weekly',
      base_visibility: 'private',
    })
  })

  test('rejects project creation when uploads are not allowed', async () => {
    checkUploadAccessMock.mockResolvedValue({ kind: 'not-allowed' })

    const response = await action({
      context: new Map(),
      request: new Request('https://artifactshare.test/api/cli/projects', {
        method: 'POST',
        body: JSON.stringify({ name: 'Blocked project' }),
      }),
    } as never)
    const body = (await response.json()) as { error: { code: string } }

    expect(response.status).toBe(403)
    expect(body.error.code).toBe('upload-not-allowed')
    expect(createDbMock).not.toHaveBeenCalled()
    expect(createProjectContainerMock).not.toHaveBeenCalled()
  })

  test('rejects missing names before creating a project', async () => {
    const response = await action({
      context: new Map(),
      request: new Request('https://artifactshare.test/api/cli/projects', {
        method: 'POST',
        body: JSON.stringify({ name: '' }),
      }),
    } as never)
    const body = (await response.json()) as { error: { code: string } }

    expect(response.status).toBe(400)
    expect(body.error.code).toBe('validation-failed')
    expect(createProjectContainerMock).not.toHaveBeenCalled()
  })

  test('rejects invalid base visibility before creating a project', async () => {
    const response = await action({
      context: new Map(),
      request: new Request('https://artifactshare.test/api/cli/projects', {
        method: 'POST',
        body: JSON.stringify({ name: 'Client', base_visibility: 'public' }),
      }),
    } as never)
    const body = (await response.json()) as { error: { code: string } }

    expect(response.status).toBe(400)
    expect(body.error.code).toBe('validation-failed')
    expect(createProjectContainerMock).not.toHaveBeenCalled()
  })

  test('rejects a duplicate active project name', async () => {
    createProjectContainerMock.mockResolvedValue({
      kind: 'project-name-conflict',
    })

    const response = await action({
      context: new Map(),
      request: new Request('https://artifactshare.test/api/cli/projects', {
        method: 'POST',
        body: JSON.stringify({ name: 'Existing project' }),
      }),
    } as never)
    const body = (await response.json()) as { error: { code: string } }

    expect(response.status).toBe(409)
    expect(body.error.code).toBe('project-name-conflict')
  })

  test('rejects project creation when the workspace plan limit is reached', async () => {
    createProjectContainerMock.mockResolvedValue({
      kind: 'project-limit-reached',
      limit: 5,
    })

    const response = await action({
      context: new Map(),
      request: new Request('https://artifactshare.test/api/cli/projects', {
        method: 'POST',
        body: JSON.stringify({ name: 'Overflow' }),
      }),
    } as never)
    const body = (await response.json()) as {
      error: { code: string; message: string }
    }

    expect(response.status).toBe(403)
    expect(body.error.code).toBe('project-limit-reached')
    expect(body.error.message).toContain('5 projects')
    expect(body.error.message).toContain('/settings/billing')
  })
})
