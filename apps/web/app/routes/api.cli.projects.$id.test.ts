import { beforeEach, describe, expect, test, vi } from 'vitest'

vi.mock('cloudflare:workers', () => ({ env: {} }))

const requireUserApiWithBearerMiddlewareMock = vi.hoisted(() => vi.fn())
const requireUserMock = vi.hoisted(() => vi.fn())
const createDbMock = vi.hoisted(() => vi.fn())
const editProjectContainerSettingsMock = vi.hoisted(() => vi.fn())

vi.mock('~/middleware/auth', () => ({
  requireUserApiWithBearerMiddleware: requireUserApiWithBearerMiddlewareMock,
}))
vi.mock('~/middleware/context', () => ({
  requireUser: requireUserMock,
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
    editProjectContainerSettings: editProjectContainerSettingsMock,
  }
})

import { action } from './api.cli.projects.$id'

const activeProject = {
  id: 'prj1',
  name: 'Launch',
  description: 'Before',
  baseVisibility: 'workspace',
  fileCount: 3,
  archivedAt: null,
}

describe('/api/cli/projects/:id', () => {
  beforeEach(() => {
    requireUserMock.mockReset()
    createDbMock.mockReset()
    editProjectContainerSettingsMock.mockReset()
    createDbMock.mockReturnValue({})
    requireUserMock.mockReturnValue({
      id: 'u1',
      email: 'owner@example.com',
      workspaceId: 'ws1',
      hd: 'example.com',
    })
    editProjectContainerSettingsMock.mockResolvedValue({
      kind: 'ok',
      project: activeProject,
      audience: ['viewer@example.com'],
    })
  })

  test('updates metadata and audience for the authenticated workspace', async () => {
    const response = await action({
      context: new Map(),
      params: { id: 'prj1' },
      request: new Request('https://artifactshare.test/api/cli/projects/prj1', {
        method: 'POST',
        body: JSON.stringify({
          name: ' Launch review ',
          description: '',
          base_visibility: 'private',
          add_emails: ['viewer@example.com'],
          remove_emails: ['old@example.com'],
        }),
      }),
    } as never)
    const body = (await response.json()) as {
      project: { id: string; base_visibility: string; archived: boolean }
      audience: string[]
    }

    expect(response.status).toBe(200)
    expect(editProjectContainerSettingsMock).toHaveBeenCalledWith(
      expect.anything(),
      'ws1',
      'prj1',
      {
        id: 'u1',
        email: 'owner@example.com',
        workspaceId: 'ws1',
        hd: 'example.com',
      },
      {
        name: ' Launch review ',
        description: '',
        baseVisibility: 'private',
        addEmails: ['viewer@example.com'],
        removeEmails: ['old@example.com'],
      },
    )
    expect(body.project).toMatchObject({
      id: 'prj1',
      base_visibility: 'workspace',
      archived: false,
    })
    expect(body.audience).toEqual(['viewer@example.com'])
  })

  test('refuses metadata edits on archived projects without unarchiving', async () => {
    editProjectContainerSettingsMock.mockResolvedValue({
      kind: 'project-archived',
    })

    const response = await action({
      context: new Map(),
      params: { id: 'prj1' },
      request: new Request('https://artifactshare.test/api/cli/projects/prj1', {
        method: 'POST',
        body: JSON.stringify({ name: 'Nope' }),
      }),
    } as never)
    const body = (await response.json()) as { error: { code: string } }

    expect(response.status).toBe(409)
    expect(body.error.code).toBe('project-archived')
  })

  test('unarchives before applying edits', async () => {
    const response = await action({
      context: new Map(),
      params: { id: 'prj1' },
      request: new Request('https://artifactshare.test/api/cli/projects/prj1', {
        method: 'POST',
        body: JSON.stringify({ archived: false, name: 'Restored' }),
      }),
    } as never)

    expect(response.status).toBe(200)
    expect(editProjectContainerSettingsMock).toHaveBeenCalledWith(
      expect.anything(),
      'ws1',
      'prj1',
      expect.objectContaining({ id: 'u1' }),
      expect.objectContaining({ archived: false, name: 'Restored' }),
    )
  })

  test('archives after edits and returns archived state', async () => {
    editProjectContainerSettingsMock.mockResolvedValue({
      kind: 'ok',
      project: {
        ...activeProject,
        archivedAt: '2026-06-02T00:00:00.000Z',
      },
      audience: ['viewer@example.com'],
    })

    const response = await action({
      context: new Map(),
      params: { id: 'prj1' },
      request: new Request('https://artifactshare.test/api/cli/projects/prj1', {
        method: 'POST',
        body: JSON.stringify({ archived: true }),
      }),
    } as never)
    const body = (await response.json()) as {
      project: { archived: boolean }
    }

    expect(response.status).toBe(200)
    expect(body.project.archived).toBe(true)
  })

  test('maps audience limit failures', async () => {
    editProjectContainerSettingsMock.mockResolvedValue({
      kind: 'too-many-grants',
    })

    const response = await action({
      context: new Map(),
      params: { id: 'prj1' },
      request: new Request('https://artifactshare.test/api/cli/projects/prj1', {
        method: 'POST',
        body: JSON.stringify({ add_emails: ['new@example.com'] }),
      }),
    } as never)
    const body = (await response.json()) as { error: { code: string } }

    expect(response.status).toBe(400)
    expect(body.error.code).toBe('too-many-grants')
  })
})
