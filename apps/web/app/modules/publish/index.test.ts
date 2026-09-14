import type { Kysely } from 'kysely'
import { beforeEach, describe, expect, expectTypeOf, test, vi } from 'vitest'
import type { DB } from '~/types/db'

const uploadShareableMock = vi.hoisted(() => vi.fn())
const createVersionMock = vi.hoisted(() => vi.fn())
const appendShareableMock = vi.hoisted(() => vi.fn())
const withDbMock = vi.hoisted(() => vi.fn())
const isAgentPublishableDestinationMock = vi.hoisted(() => vi.fn())
const isAgentOwnedArtifactMock = vi.hoisted(() => vi.fn())

vi.mock('~/services/shareables.server', () => ({
  appendShareable: appendShareableMock,
  createVersion: createVersionMock,
  uploadShareable: uploadShareableMock,
}))
vi.mock('~/services/db.server', () => ({ withDb: withDbMock }))
vi.mock('~/services/agent-scope.server', () => ({
  isAgentOwnedArtifact: isAgentOwnedArtifactMock,
  isAgentPublishableDestination: isAgentPublishableDestinationMock,
}))

import { publish, publishPrincipal, type PublishAppendResult } from './index'

const readVisibility = vi.fn()
const db = {
  selectFrom: vi.fn(() => ({
    select: vi.fn(() => ({
      where: vi.fn(() => ({ executeTakeFirst: readVisibility })),
    })),
  })),
} as unknown as Kysely<DB>
const user = {
  id: 'user-1',
  kind: 'human' as const,
  email: 'user@example.com',
  emailVerified: true,
  selfUploadEnabled: true,
  workspaceId: 'workspace-1',
  hd: 'example.com',
}

describe('publish', () => {
  beforeEach(() => {
    readVisibility.mockReset().mockResolvedValue({ visibility: 'link' })
    uploadShareableMock.mockReset().mockResolvedValue({ kind: 'ok' })
    createVersionMock.mockReset().mockResolvedValue({ kind: 'ok' })
    appendShareableMock.mockReset().mockResolvedValue({ kind: 'ok' })
    isAgentPublishableDestinationMock.mockReset().mockResolvedValue(true)
    isAgentOwnedArtifactMock.mockReset().mockResolvedValue(true)
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
    })

    expect(createVersionMock).toHaveBeenCalledTimes(1)
    expect(createVersionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        db,
        shareableId: 'artifact-1',
        expectedCurrentVersionId: 'version-1',
        authority,
        agentProfileId: 'agent-1',
      }),
    )
    expect(createVersionMock.mock.calls[0]?.[0].file.name).toBe(
      'replacement.md',
    )
    expect(uploadShareableMock).not.toHaveBeenCalled()
  })

  test('returns append visibility even when reads fail after the commit', async () => {
    const waitUntil = vi.fn()
    const readContent = vi.fn().mockResolvedValue('<p>next</p>')
    appendShareableMock.mockImplementationOnce(async () => {
      readVisibility.mockRejectedValue(new Error('database unavailable'))
      return {
        kind: 'ok',
        versionId: 'version-2',
        artifactKind: 'html_page',
      }
    })

    const result = await publish({
      db,
      actor: { kind: 'human', user },
      target: { kind: 'append', artifactId: 'artifact-1' },
      content: { kind: 'append', content: readContent },
      waitUntil,
    })

    expect(readContent).toHaveBeenCalledTimes(1)
    expect(readVisibility).toHaveBeenCalledTimes(1)
    expectTypeOf(result).toEqualTypeOf<PublishAppendResult>()
    expect(appendShareableMock).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        id: user.id,
        workspaceId: user.workspaceId,
      }),
      'artifact-1',
      '<p>next</p>',
      { waitUntil },
    )
    expect(result).toEqual({
      kind: 'ok',
      versionId: 'version-2',
      artifactKind: 'html_page',
      visibility: 'link',
    })
  })

  test('does not append when response visibility cannot be read', async () => {
    readVisibility.mockRejectedValueOnce(new Error('database unavailable'))

    await expect(
      publish({
        db,
        actor: { kind: 'human', user },
        target: { kind: 'append', artifactId: 'artifact-1' },
        content: { kind: 'append', content: 'next' },
      }),
    ).rejects.toThrow('database unavailable')

    expect(appendShareableMock).not.toHaveBeenCalled()
  })

  test('returns not-found without appending when the artifact is missing', async () => {
    readVisibility.mockResolvedValueOnce(undefined)

    const result = await publish({
      db,
      actor: { kind: 'human', user },
      target: { kind: 'append', artifactId: 'artifact-1' },
      content: { kind: 'append', content: 'next' },
    })

    expect(result).toEqual({ kind: 'not-found' })
    expect(appendShareableMock).not.toHaveBeenCalled()
  })

  test('denies append outside an agent owned scope before reading content', async () => {
    const authority = {
      kind: 'agent' as const,
      familyId: 'family-1',
      workspaceId: user.workspaceId,
      projectId: 'project-1',
      projectNameSnapshot: 'Project',
      agentProfileId: 'agent-1',
    }
    isAgentOwnedArtifactMock.mockResolvedValueOnce(false)

    const readContent = vi.fn().mockResolvedValue(null)
    const result = await publish({
      db,
      actor: { kind: 'agent', user, authority },
      target: { kind: 'append', artifactId: 'artifact-1' },
      content: { kind: 'append', content: readContent },
    })

    expect(result).toEqual({ kind: 'forbidden' })
    expect(isAgentOwnedArtifactMock).toHaveBeenCalledWith(
      db,
      { workspaceId: user.workspaceId, email: user.email },
      authority,
      'artifact-1',
    )
    expect(readContent).not.toHaveBeenCalled()
    expect(appendShareableMock).not.toHaveBeenCalled()
  })

  test('denies append when self upload is disabled', async () => {
    const readContent = vi.fn().mockResolvedValue(null)
    const result = await publish({
      db,
      actor: {
        kind: 'human',
        user: { ...user, selfUploadEnabled: false },
      },
      target: { kind: 'append', artifactId: 'artifact-1' },
      content: { kind: 'append', content: readContent },
    })

    expect(result).toEqual({ kind: 'self-upload-disabled' })
    expect(readContent).not.toHaveBeenCalled()
    expect(appendShareableMock).not.toHaveBeenCalled()
  })

  test('rejects invalid lazy append content before any append write', async () => {
    const readContent = vi.fn().mockResolvedValue(null)
    const result = await publish({
      db,
      actor: { kind: 'human', user },
      target: { kind: 'append', artifactId: 'artifact-1' },
      content: { kind: 'append', content: readContent },
    })

    expect(result).toEqual({ kind: 'invalid-append-content' })
    expect(readContent).toHaveBeenCalledTimes(1)
    expect(appendShareableMock).not.toHaveBeenCalled()
  })

  test.each([
    { kind: 'not-found' as const },
    { kind: 'copy-forbidden' as const },
    { kind: 'storage-failed' as const },
    { kind: 'quota-exceeded' as const },
    { kind: 'version-conflict' as const, currentVersionId: 'version-2' },
  ])('preserves append service result $kind', async (serviceResult) => {
    appendShareableMock.mockResolvedValueOnce(serviceResult)

    const result = await publish({
      db,
      actor: { kind: 'human', user },
      target: { kind: 'append', artifactId: 'artifact-1' },
      content: { kind: 'append', content: 'next' },
    })

    expect(result).toEqual(serviceResult)
  })

  test('constructs CLI principals without widening bot authority', () => {
    const authority = {
      kind: 'agent' as const,
      familyId: 'family-1',
      workspaceId: user.workspaceId,
      projectId: 'project-1',
      projectNameSnapshot: 'Project',
      agentProfileId: 'agent-1',
    }

    expect(publishPrincipal(user, null)).toEqual({ kind: 'human', user })
    expect(publishPrincipal({ ...user, kind: 'bot' }, authority)).toMatchObject(
      { kind: 'bot', authority },
    )
    expect(publishPrincipal({ ...user, kind: 'bot' }, null)).toBeNull()
  })

  test('normalizes an incomplete personal identity before selecting visibility', async () => {
    const personalUser = {
      id: 'user-2',
      kind: 'human' as const,
      email: 'personal@example.com',
      workspaceId: 'workspace-2',
    }

    await publish({
      db,
      actor: { kind: 'human', user: personalUser },
      destination: { kind: 'home' },
      target: { kind: 'create' },
      content: {
        kind: 'file',
        path: 'note.txt',
        bytes: new Uint8Array([1, 2]),
      },
      notify: { slack: false },
    })

    expect(uploadShareableMock).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        workspaceId: 'workspace-2',
        hd: null,
        msTenantId: null,
        emailVerified: false,
      }),
      expect.any(File),
      'private',
      [],
      null,
      null,
      expect.any(Object),
    )
  })

  test('requires an optimistic version for agent updates', async () => {
    const authority = {
      kind: 'agent' as const,
      familyId: 'family-1',
      workspaceId: user.workspaceId,
      projectId: 'project-1',
      projectNameSnapshot: 'Project',
      agentProfileId: 'agent-1',
    }

    const result = await publish({
      db,
      actor: { kind: 'agent', user, authority },
      target: { kind: 'update', artifactId: 'artifact-1' },
      content: {
        kind: 'file',
        path: 'replacement.md',
        bytes: new TextEncoder().encode('# replacement'),
      },
    })

    expect(result).toEqual({ kind: 'expected-version-required' })
    expect(createVersionMock).not.toHaveBeenCalled()
  })

  test('passes an absent agent email through to the legacy scope check', async () => {
    const authority = {
      kind: 'agent' as const,
      familyId: 'family-1',
      workspaceId: user.workspaceId,
      projectId: 'project-1',
      projectNameSnapshot: 'Project',
      agentProfileId: 'agent-1',
    }
    const agentUser = { ...user, email: undefined }

    await publish({
      db,
      actor: { kind: 'agent', user: agentUser, authority },
      destination: { kind: 'project', id: 'project-1' },
      target: { kind: 'create' },
      content: { kind: 'file', path: 'note.txt', bytes: new Uint8Array([1]) },
      visibility: 'workspace',
      notify: { slack: false },
    })

    expect(isAgentPublishableDestinationMock).toHaveBeenCalledWith(
      db,
      { workspaceId: user.workspaceId, email: '' },
      authority,
      'project-1',
    )
    expect(uploadShareableMock).toHaveBeenCalledTimes(1)
  })

  test('does not let an agent publish outside its approved project', async () => {
    const authority = {
      kind: 'agent' as const,
      familyId: 'family-1',
      workspaceId: user.workspaceId,
      projectId: 'project-1',
      projectNameSnapshot: 'Project',
      agentProfileId: 'agent-1',
    }
    isAgentPublishableDestinationMock.mockResolvedValueOnce(false)

    const result = await publish({
      db,
      actor: { kind: 'agent', user, authority },
      destination: { kind: 'project', id: 'project-2' },
      target: { kind: 'create' },
      content: { kind: 'file', path: 'note.txt', bytes: new Uint8Array([1]) },
      notify: { slack: false },
    })

    expect(result).toEqual({ kind: 'forbidden' })
    expect(uploadShareableMock).not.toHaveBeenCalled()
  })

  test('rejects an actor and authority with different effective kinds', async () => {
    const authority = {
      kind: 'agent' as const,
      familyId: 'family-1',
      workspaceId: user.workspaceId,
      projectId: 'project-1',
      projectNameSnapshot: 'Project',
      agentProfileId: 'agent-1',
    }

    const result = await publish({
      db,
      actor: {
        kind: 'human',
        user: { ...user, kind: 'bot' } as never,
        authority: authority as never,
      },
      destination: { kind: 'home' },
      target: { kind: 'create' },
      content: { kind: 'file', path: 'note.txt', bytes: new Uint8Array([1]) },
      notify: { slack: false },
    })

    expect(result).toEqual({ kind: 'forbidden' })
    expect(uploadShareableMock).not.toHaveBeenCalled()
  })

  test('rejects bridge authorities until the bridge contract is behind publish', async () => {
    const authority = {
      kind: 'bridge' as const,
      familyId: 'family-1',
      bridgeAuthorityId: 'bridge-1',
      workspaceId: user.workspaceId,
      fallbackProjectId: 'project-1',
      agentProfileId: 'agent-1',
      sourceKind: 'slack',
      sourceInstallationId: 'installation-1',
      externalWorkspaceId: 'external-1',
    }

    const result = await publish({
      db,
      actor: { kind: 'bridge', user, authority },
      destination: { kind: 'home' },
      target: { kind: 'create' },
      content: { kind: 'file', path: 'note.txt', bytes: new Uint8Array([1]) },
      notify: { slack: false },
    })

    expect(result).toEqual({ kind: 'forbidden' })
    expect(uploadShareableMock).not.toHaveBeenCalled()
  })

  test('keeps named-recipient creates private when visibility is omitted', async () => {
    await publish({
      db,
      actor: { kind: 'human', user },
      destination: { kind: 'home' },
      target: { kind: 'create' },
      content: { kind: 'file', path: 'note.txt', bytes: new Uint8Array([1]) },
      grantEmails: ['recipient@example.com'],
      notify: { slack: false },
    })

    expect(uploadShareableMock.mock.calls[0]?.[3]).toBe('private')
    expect(uploadShareableMock.mock.calls[0]?.[4]).toEqual([
      'recipient@example.com',
    ])
  })

  test('does not accept a destination claim on updates', async () => {
    const result = await publish({
      db,
      actor: { kind: 'human', user },
      destination: { kind: 'project', id: 'project-a' } as never,
      target: { kind: 'update', artifactId: 'artifact-1' },
      content: {
        kind: 'file',
        path: 'replacement.md',
        bytes: new Uint8Array([1]),
      },
    })

    expect(result).toEqual({ kind: 'forbidden' })
    expect(createVersionMock).not.toHaveBeenCalled()
  })

  test('runs a static-site create through its session adapter', async () => {
    const sessionResult = {
      kind: 'ok' as const,
      id: 'site-1',
      versionId: 'version-1',
      visibility: 'private' as const,
      linkExpiresAt: null,
    }
    const publishSession = vi.fn().mockResolvedValue(sessionResult)

    const result = await publish({
      db,
      actor: { kind: 'human', user },
      destination: { kind: 'project', id: 'project-1' },
      target: { kind: 'create' },
      content: { kind: 'site', session: { publish: publishSession } },
      idempotencyKey: 'site-key',
      notify: { slack: true },
    })

    expect(result).toEqual(sessionResult)
    expect(publishSession).toHaveBeenCalledWith(
      expect.objectContaining({
        db,
        target: { kind: 'create' },
        containerId: 'project-1',
        idempotencyKey: 'site-key',
      }),
    )
    expect(uploadShareableMock).not.toHaveBeenCalled()
    expect(createVersionMock).not.toHaveBeenCalled()
  })

  test('runs a static-site update through its session adapter with version guards', async () => {
    const sessionResult = {
      kind: 'static-site-update-ok' as const,
      result: { kind: 'ok' as const, id: 'site-1', versionId: 'version-2' },
      shareUrlVisibility: 'private' as const,
    }
    const publishSession = vi.fn().mockResolvedValue(sessionResult)

    const result = await publish({
      db,
      actor: { kind: 'human', user },
      target: {
        kind: 'update',
        artifactId: 'site-1',
        expectedVersionId: 'version-1',
      },
      content: { kind: 'site', session: { publish: publishSession } },
      touchArtifactKeyId: 'key-1',
    })

    expect(result).toEqual(sessionResult)
    expect(publishSession).toHaveBeenCalledWith(
      expect.objectContaining({
        db,
        target: {
          kind: 'update',
          artifactId: 'site-1',
          expectedVersionId: 'version-1',
        },
        containerId: null,
        idempotencyKey: null,
        touchArtifactKeyId: 'key-1',
      }),
    )
    expect(uploadShareableMock).not.toHaveBeenCalled()
    expect(createVersionMock).not.toHaveBeenCalled()
  })

  test('rejects bootstrap authority before invoking a publish service', async () => {
    const result = await publish({
      db,
      actor: {
        kind: 'bootstrap',
        user,
        authority: {
          kind: 'bootstrap',
          preset: 'agent',
          workspaceId: 'workspace-1',
          projectId: 'project-1',
          expiresAt: '2026-09-14T00:00:00.000Z',
        },
      },
      destination: { kind: 'home' },
      target: { kind: 'create' },
      content: {
        kind: 'file',
        path: 'index.html',
        bytes: new Blob(['hello'], { type: 'text/html' }),
      },
      notify: { slack: true },
    })

    expect(result).toEqual({ kind: 'forbidden' })
    expect(uploadShareableMock).not.toHaveBeenCalled()
    expect(createVersionMock).not.toHaveBeenCalled()
  })
})
