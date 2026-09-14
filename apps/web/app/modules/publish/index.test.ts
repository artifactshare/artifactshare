import type { Kysely } from 'kysely'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import type { DB } from '~/types/db'

const uploadShareableMock = vi.hoisted(() => vi.fn())
const createVersionMock = vi.hoisted(() => vi.fn())
const withDbMock = vi.hoisted(() => vi.fn())

vi.mock('~/services/shareables.server', () => ({
  createVersion: createVersionMock,
  uploadShareable: uploadShareableMock,
}))
vi.mock('~/services/db.server', () => ({ withDb: withDbMock }))

import { publish } from './index'

const db = {} as Kysely<DB>
const user = {
  id: 'user-1',
  email: 'user@example.com',
  emailVerified: true,
  workspaceId: 'workspace-1',
  hd: 'example.com',
}

describe('publish', () => {
  beforeEach(() => {
    uploadShareableMock.mockReset().mockResolvedValue({ kind: 'ok' })
    createVersionMock.mockReset().mockResolvedValue({ kind: 'ok' })
  })

  test('delegates a file-create intent without changing the existing upload contract', async () => {
    const bytes = new TextEncoder().encode('<p>hello</p>')

    await publish({
      db,
      actor: { kind: 'human', user },
      destination: { kind: 'home' },
      target: { kind: 'create' },
      content: { kind: 'file', path: 'hello.html', bytes },
      notify: { slack: false },
    })

    expect(uploadShareableMock).toHaveBeenCalledTimes(1)
    const [
      calledDb,
      calledUser,
      calledFile,
      visibility,
      grants,
      containerId,
      key,
      options,
    ] = uploadShareableMock.mock.calls[0]
    expect(calledDb).toBe(db)
    expect(calledUser).toEqual({
      id: user.id,
      email: user.email,
      emailVerified: true,
      workspaceId: user.workspaceId,
      hd: user.hd,
      msTenantId: null,
    })
    expect(calledFile).toBeInstanceOf(File)
    expect(calledFile.name).toBe('hello.html')
    await expect(calledFile.text()).resolves.toBe('<p>hello</p>')
    expect(visibility).toBe('workspace')
    expect(grants).toEqual([])
    expect(containerId).toBeNull()
    expect(key).toBeNull()
    expect(options).toEqual({ slackNotify: false })
  })

  test('delegates an update intent with its optimistic version and authority', async () => {
    const authority = {
      kind: 'agent' as const,
      familyId: 'family-1',
      workspaceId: user.workspaceId,
      projectId: 'project-1',
      projectNameSnapshot: 'Project',
      agentProfileId: 'agent-1',
    }

    await publish({
      db,
      actor: { kind: 'agent', user, authority },
      destination: { kind: 'project', id: 'project-1' },
      target: {
        kind: 'update',
        artifactId: 'artifact-1',
        expectedVersionId: 'version-1',
      },
      content: {
        kind: 'file',
        path: 'replacement.md',
        bytes: new TextEncoder().encode('# replacement'),
        mediaType: 'text/markdown',
      },
      notify: { slack: true },
    })

    expect(createVersionMock).toHaveBeenCalledTimes(1)
    expect(createVersionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        db,
        shareableId: 'artifact-1',
        expectedCurrentVersionId: 'version-1',
        authority,
      }),
    )
    expect(createVersionMock.mock.calls[0]?.[0].file.name).toBe(
      'replacement.md',
    )
    expect(uploadShareableMock).not.toHaveBeenCalled()
  })
})
