import { beforeEach, describe, expect, test, vi } from 'vitest'

const loadCommentAccessMock = vi.hoisted(() => vi.fn())
const getArtifactMock = vi.hoisted(() => vi.fn())

vi.mock('cloudflare:workers', () => ({
  env: { BUCKET: {} },
}))
vi.mock('~/services/comments.server', () => ({
  loadCommentAccess: loadCommentAccessMock,
}))
vi.mock('~/services/storage.server', () => ({
  getArtifact: getArtifactMock,
}))

import {
  getCliDownloadFile,
  getCliDownloadManifest,
} from './cli-download.server'

const user = {
  id: 'u1',
  email: 'owner@example.com',
  emailVerified: true,
  name: 'Owner',
  image: null,
  workspaceId: 'ws1',
  hd: 'example.com',
  msTenantId: null,
  locale: 'en',
}

describe('getCliDownloadManifest', () => {
  beforeEach(() => {
    loadCommentAccessMock.mockReset()
    getArtifactMock.mockReset()
    loadCommentAccessMock.mockResolvedValue({
      shareableId: 'abc123def4',
      workspaceId: 'ws1',
      ownerUserId: 'u1',
      visibility: 'private',
      currentVersionId: 'ver123',
      artifactKind: 'markdown_page',
      entrypointPath: '/report.md',
      r2Key: 'artifacts/abc123def4/ver123/index.md',
      isTeamWorkspaceAdmin: false,
    })
    getArtifactMock.mockResolvedValue({
      body: new ReadableStream(),
      text: vi.fn(),
      httpMetadata: { contentType: 'text/markdown; charset=utf-8' },
      size: 8,
      uploaded: new Date('2026-06-09T00:00:00.000Z'),
    })
  })

  test('returns a single-file manifest for readable Markdown', async () => {
    const result = await getCliDownloadManifest(
      versionMetadataDb({ size_bytes: 8, sha256: 'sha-report' }) as never,
      user,
      {
        id: 'abc123def4',
        baseUrl: 'https://artifactshare.test',
      },
    )

    expect(result.kind).toBe('ok')
    if (result.kind !== 'ok') return
    expect(result.data).toMatchObject({
      id: 'abc123def4',
      share_url: 'https://artifactshare.test/a/abc123def4',
      version_id: 'ver123',
      artifact_kind: 'markdown_page',
      total_size_bytes: 8,
      files: [
        {
          path: '/report.md',
          size_bytes: 8,
          content_type: 'text/markdown; charset=utf-8',
          sha256: 'sha-report',
        },
      ],
    })
  })

  test('returns a static site manifest from version_files', async () => {
    loadCommentAccessMock.mockResolvedValue({
      shareableId: 'site123abc',
      workspaceId: 'ws1',
      ownerUserId: 'u1',
      visibility: 'private',
      currentVersionId: 'ver999',
      artifactKind: 'static_site',
      entrypointPath: '/index.html',
      r2Key: 'ws1/site123abc/ver999/index.html',
      isTeamWorkspaceAdmin: false,
      projectId: 'project-a',
    })
    const db = versionFilesDb([
      {
        path: '/assets/app.js',
        size_bytes: 20,
        mime_type: 'text/javascript',
        sha256: 'sha-app',
      },
      {
        path: '/index.html',
        size_bytes: 10,
        mime_type: 'text/html',
        sha256: 'sha-index',
      },
    ])

    const result = await getCliDownloadManifest(db as never, user, {
      id: 'site123abc',
      baseUrl: 'https://artifactshare.test',
    })

    expect(result.kind).toBe('ok')
    if (result.kind !== 'ok') return
    expect(result.data.total_size_bytes).toBe(30)
    expect(result.data.project_id).toBe('project-a')
    expect(result.data.files.map((file) => file.path)).toEqual([
      '/assets/app.js',
      '/index.html',
    ])
    expect(getArtifactMock).not.toHaveBeenCalled()
  })

  test('returns not-found when access is missing', async () => {
    loadCommentAccessMock.mockResolvedValue(null)

    const result = await getCliDownloadManifest({} as never, user, {
      id: 'nope',
      baseUrl: 'https://artifactshare.test',
    })

    expect(result).toEqual({ kind: 'not-found' })
  })

  test('returns unsupported-kind for known artifacts outside the download scope', async () => {
    loadCommentAccessMock.mockResolvedValue({
      shareableId: 'spa123abcd',
      workspaceId: 'ws1',
      ownerUserId: 'u1',
      visibility: 'private',
      currentVersionId: 'ver123',
      artifactKind: 'spa',
      entrypointPath: '/index.html',
      r2Key: 'artifacts/spa123abcd/ver123/index.html',
      isTeamWorkspaceAdmin: false,
    })

    const result = await getCliDownloadManifest({} as never, user, {
      id: 'spa123abcd',
      baseUrl: 'https://artifactshare.test',
    })

    expect(result).toEqual({ kind: 'unsupported-kind', artifactKind: 'spa' })
  })
})

describe('getCliDownloadFile', () => {
  beforeEach(() => {
    loadCommentAccessMock.mockReset()
    getArtifactMock.mockReset()
  })

  test('returns a static site file selected by manifest path', async () => {
    loadCommentAccessMock.mockResolvedValue({
      shareableId: 'site123abc',
      workspaceId: 'ws1',
      ownerUserId: 'u1',
      visibility: 'private',
      currentVersionId: 'ver999',
      artifactKind: 'static_site',
      entrypointPath: '/index.html',
      r2Key: 'ws1/site123abc/ver999/index.html',
      isTeamWorkspaceAdmin: false,
    })
    const object = {
      body: new ReadableStream(),
      text: vi.fn(),
      httpMetadata: { contentType: 'text/javascript' },
      size: 20,
      uploaded: new Date('2026-06-09T00:00:00.000Z'),
    }
    getArtifactMock.mockResolvedValue(object)

    const result = await getCliDownloadFile(
      versionFileDb({
        path: '/assets/app.js',
        r2_key: 'ws1/site123abc/ver999/assets/app.js',
        size_bytes: 20,
        mime_type: 'text/javascript',
        sha256: 'sha-app',
      }) as never,
      user,
      { id: 'site123abc', path: '/assets/app.js' },
    )

    expect(result.kind).toBe('ok')
    if (result.kind !== 'ok') return
    expect(result.file.path).toBe('/assets/app.js')
    expect(result.object).toBe(object)
    expect(getArtifactMock).toHaveBeenCalledWith(
      {},
      'ws1/site123abc/ver999/assets/app.js',
    )
  })
})

function versionFilesDb(rows: unknown[]) {
  return {
    selectFrom: () => ({
      select: () => ({
        where: () => ({
          orderBy: () => ({
            execute: vi.fn().mockResolvedValue(rows),
          }),
        }),
      }),
    }),
  }
}

function versionMetadataDb(row: { size_bytes: number; sha256: string }) {
  return {
    selectFrom: () => ({
      select: () => ({
        where: () => ({
          executeTakeFirst: vi.fn().mockResolvedValue(row),
        }),
      }),
    }),
  }
}

function versionFileDb(row: unknown) {
  return {
    selectFrom: () => ({
      select: () => ({
        where: () => ({
          where: () => ({
            executeTakeFirst: vi.fn().mockResolvedValue(row),
          }),
        }),
      }),
    }),
  }
}
