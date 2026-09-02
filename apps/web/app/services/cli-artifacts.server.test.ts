import { beforeEach, describe, expect, test, vi } from 'vitest'

const loadCommentAccessMock = vi.hoisted(() => vi.fn())
const loadCommentThreadsMock = vi.hoisted(() => vi.fn())
const fetchArtifactSourceMock = vi.hoisted(() => vi.fn())
const listOwnedArtifactVersionsMock = vi.hoisted(() => vi.fn())
const listArtifactVersionsMock = vi.hoisted(() => vi.fn())
const listOwnedShareablesMock = vi.hoisted(() => vi.fn())
const findWorkspaceProjectMock = vi.hoisted(() => vi.fn())
const findSharedProjectForViewerMock = vi.hoisted(() => vi.fn())

vi.mock('~/services/comments.server', () => ({
  COMMENT_THREAD_LIST_LIMIT: 50,
  loadCommentAccess: loadCommentAccessMock,
  loadCommentThreads: loadCommentThreadsMock,
}))
vi.mock('~/services/content.server', () => ({
  fetchArtifactSource: fetchArtifactSourceMock,
}))
vi.mock('~/services/shareables.server', () => ({
  listOwnedArtifactVersions: listOwnedArtifactVersionsMock,
  listArtifactVersions: listArtifactVersionsMock,
  listOwnedShareables: listOwnedShareablesMock,
}))
vi.mock('~/services/projects.server', () => ({
  findWorkspaceProject: findWorkspaceProjectMock,
  findSharedProjectForViewer: findSharedProjectForViewerMock,
  visibleShareableToViewerSql: vi.fn(),
  visibleSharedProjectShareableToViewerSql: vi.fn(),
}))

import {
  CLI_ARTIFACTS_LIST_LIMIT,
  listCliArtifacts,
} from './cli-artifacts.server'
import { getArtifactReadback } from './artifact-readback-service.server'

const user = {
  id: 'u1',
  email: 'owner@example.com',
  emailVerified: true,
  name: 'Owner',
  image: null,
  workspaceId: 'ws1',
  hd: 'example.com',
  msTenantId: null,
  kind: 'human' as const,
  locale: 'en',
}

describe('getArtifactReadback', () => {
  beforeEach(() => {
    loadCommentAccessMock.mockReset()
    loadCommentThreadsMock.mockReset()
    fetchArtifactSourceMock.mockReset()
    listOwnedArtifactVersionsMock.mockReset()
    listOwnedShareablesMock.mockReset()
    findWorkspaceProjectMock.mockReset()
    loadCommentAccessMock.mockResolvedValue({
      shareableId: 'abc123def4',
      workspaceId: 'ws1',
      ownerUserId: 'u1',
      visibility: 'private',
      currentVersionId: 'ver123',
      artifactKind: 'markdown_page',
      entrypointPath: null,
      r2Key: 'artifacts/abc123def4/ver123/index.md',
      isTeamWorkspaceAdmin: false,
      projectId: 'project-a',
    })
    fetchArtifactSourceMock.mockResolvedValue({
      kind: 'ok',
      body: '# Report',
      sizeBytes: 8,
    })
  })

  test('returns source metadata for a readable artifact', async () => {
    const result = await getArtifactReadback({} as never, user, {
      id: 'abc123def4',
      baseUrl: 'https://artifactshare.test',
    })

    expect(result.kind).toBe('ok')
    if (result.kind !== 'ok') return
    expect(result.data).toMatchObject({
      id: 'abc123def4',
      project_id: 'project-a',
      share_url: 'https://artifactshare.test/a/abc123def4',
      version_id: 'ver123',
      format: 'markdown',
      content: '# Report',
      size_bytes: 8,
      truncated: false,
      next_offset: null,
    })
  })

  test('paginates large source content by offset', async () => {
    fetchArtifactSourceMock.mockResolvedValue({
      kind: 'ok',
      body: `${'x'.repeat(200_000)}tail`,
      sizeBytes: 200_004,
    })

    const first = await getArtifactReadback({} as never, user, {
      id: 'abc123def4',
      baseUrl: 'https://artifactshare.test',
    })
    const second = await getArtifactReadback({} as never, user, {
      id: 'abc123def4',
      baseUrl: 'https://artifactshare.test',
      offset: 200_000,
    })

    expect(first.kind).toBe('ok')
    expect(second.kind).toBe('ok')
    if (first.kind !== 'ok' || second.kind !== 'ok') return
    expect(first.data.truncated).toBe(true)
    expect(first.data.next_offset).toBe(200_000)
    expect(second.data.content).toBe('tail')
    expect(second.data.truncated).toBe(false)
  })

  test('includes versions only for owned artifacts', async () => {
    listOwnedArtifactVersionsMock.mockResolvedValue({
      versions: [
        {
          versionId: 'ver123',
          status: 'published',
          sizeBytes: 8,
          createdAt: '2026-06-09T00:00:00.000Z',
          publishedAt: '2026-06-09T00:00:00.000Z',
          isCurrent: true,
        },
      ],
      hasMore: false,
    })

    const owned = await getArtifactReadback({} as never, user, {
      id: 'abc123def4',
      baseUrl: 'https://artifactshare.test',
      include: ['versions'],
    })
    loadCommentAccessMock.mockResolvedValueOnce({
      shareableId: 'theirs',
      workspaceId: 'ws1',
      ownerUserId: 'u2',
      visibility: 'workspace',
      currentVersionId: 'ver999',
      artifactKind: 'markdown_page',
      entrypointPath: null,
      r2Key: 'artifacts/theirs/ver999/index.md',
      isTeamWorkspaceAdmin: false,
    })
    const shared = await getArtifactReadback({} as never, user, {
      id: 'theirs',
      baseUrl: 'https://artifactshare.test',
      include: ['versions'],
    })

    expect(owned.kind).toBe('ok')
    expect(shared.kind).toBe('ok')
    if (owned.kind !== 'ok' || shared.kind !== 'ok') return
    expect(owned.data.versions?.[0]?.version_id).toBe('ver123')
    expect(shared.data).not.toHaveProperty('versions')
  })

  test('includes comments for viewable artifacts', async () => {
    loadCommentThreadsMock.mockResolvedValue([
      {
        id: 'thread1',
        status: 'open',
        resolvedAt: null,
        createdAt: '2026-06-09T00:00:00.000Z',
        updatedAt: '2026-06-09T00:00:00.000Z',
        subject: { kind: 'artifact' },
        messages: [
          {
            id: 'msg1',
            author: { name: 'Owner', email: 'owner@example.com' },
            body: 'Looks good',
            createdAt: '2026-06-09T00:00:00.000Z',
            updatedAt: '2026-06-09T00:00:00.000Z',
          },
        ],
      },
    ])

    const result = await getArtifactReadback({} as never, user, {
      id: 'abc123def4',
      baseUrl: 'https://artifactshare.test',
      include: ['comments'],
    })

    expect(result.kind).toBe('ok')
    if (result.kind !== 'ok') return
    expect(result.data.comments?.[0]?.messages[0]?.body).toBe('Looks good')
    expect(result.data.comments_has_more).toBe(false)
  })

  test('returns not-found when access is missing', async () => {
    loadCommentAccessMock.mockResolvedValue(null)

    const result = await getArtifactReadback({} as never, user, {
      id: 'nope',
      baseUrl: 'https://artifactshare.test',
    })

    expect(result).toEqual({ kind: 'not-found' })
    expect(fetchArtifactSourceMock).not.toHaveBeenCalled()
  })

  test('returns unsupported-kind for multi-file artifacts', async () => {
    loadCommentAccessMock.mockResolvedValue({
      shareableId: 'site123abc',
      workspaceId: 'ws1',
      ownerUserId: 'u1',
      visibility: 'private',
      currentVersionId: 'ver123',
      artifactKind: 'static_site',
      entrypointPath: 'index.html',
      r2Key: 'artifacts/site123abc/ver123/',
      isTeamWorkspaceAdmin: false,
    })

    const result = await getArtifactReadback({} as never, user, {
      id: 'site123abc',
      baseUrl: 'https://artifactshare.test',
    })

    expect(result).toEqual({
      kind: 'unsupported-kind',
      artifactKind: 'static_site',
    })
    expect(fetchArtifactSourceMock).not.toHaveBeenCalled()
  })
})

describe('listCliArtifacts', () => {
  beforeEach(() => {
    listOwnedShareablesMock.mockReset()
    findWorkspaceProjectMock.mockReset()
  })

  test('lists owned artifacts with share URLs and pagination metadata', async () => {
    listOwnedShareablesMock.mockResolvedValue([
      {
        id: 'abc123def4',
        title: 'Weekly report',
        visibility: 'private',
        updatedAt: '2026-06-18T00:00:00.000Z',
        projectId: null,
        artifactKind: 'markdown_page',
      },
    ])

    const result = await listCliArtifacts({} as never, user, {
      baseUrl: 'https://artifactshare.test',
      query: 'report',
    })

    expect(result.kind).toBe('ok')
    if (result.kind !== 'ok') return
    expect(result.data).toEqual({
      artifacts: [
        {
          id: 'abc123def4',
          title: 'Weekly report',
          share_url: 'https://artifactshare.test/a/abc123def4',
          visibility: 'private',
          updated_at: '2026-06-18T00:00:00.000Z',
          project_id: null,
          artifact_kind: 'markdown_page',
        },
      ],
      limit: CLI_ARTIFACTS_LIST_LIMIT,
      has_more: false,
      next_cursor: null,
    })
    expect(listOwnedShareablesMock).toHaveBeenCalledWith(
      expect.anything(),
      user,
      {
        limit: CLI_ARTIFACTS_LIST_LIMIT + 1,
        projectId: undefined,
        query: 'report',
      },
    )
  })

  test('lists one page when more owned artifacts exist', async () => {
    listOwnedShareablesMock.mockResolvedValue(
      Array.from({ length: CLI_ARTIFACTS_LIST_LIMIT + 1 }, (_, index) => ({
        id: `artifact${index}`,
        title: `Artifact ${index}`,
        visibility: 'private',
        updatedAt: '2026-06-18T00:00:00.000Z',
        projectId: null,
      })),
    )

    const result = await listCliArtifacts({} as never, user, {
      baseUrl: 'https://artifactshare.test',
    })

    expect(result.kind).toBe('ok')
    if (result.kind !== 'ok') return
    expect(result.data.artifacts).toHaveLength(CLI_ARTIFACTS_LIST_LIMIT)
    expect(result.data.has_more).toBe(true)
    expect(result.data.next_cursor).toEqual(expect.any(String))
  })

  test('rejects unavailable project filters before listing', async () => {
    findWorkspaceProjectMock.mockResolvedValue(null)
    findSharedProjectForViewerMock.mockResolvedValue(null)

    const result = await listCliArtifacts({} as never, user, {
      baseUrl: 'https://artifactshare.test',
      projectId: 'missing',
    })

    expect(result).toEqual({ kind: 'invalid-project' })
    expect(findWorkspaceProjectMock).toHaveBeenCalledWith(
      expect.anything(),
      'ws1',
      'missing',
      user,
    )
    expect(listOwnedShareablesMock).not.toHaveBeenCalled()
  })

  test('allows home filters without project lookup', async () => {
    listOwnedShareablesMock.mockResolvedValue([])

    const result = await listCliArtifacts({} as never, user, {
      baseUrl: 'https://artifactshare.test',
      projectId: '',
    })

    expect(result.kind).toBe('ok')
    expect(findWorkspaceProjectMock).not.toHaveBeenCalled()
    expect(listOwnedShareablesMock).toHaveBeenCalledWith(
      expect.anything(),
      user,
      expect.objectContaining({ projectId: '' }),
    )
  })
})
