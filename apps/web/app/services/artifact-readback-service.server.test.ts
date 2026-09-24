import { beforeEach, expect, test, vi } from 'vitest'
import { ArtifactReadResponseSchema } from '@artifactshare/contract'

vi.mock('cloudflare:workers', () => ({ env: { APP_ENV: 'development' } }))

const access = vi.hoisted(() => vi.fn())
const history = vi.hoisted(() => vi.fn())
const fetchSource = vi.hoisted(() => vi.fn())
vi.mock('~/services/comments.server', () => ({
  COMMENT_THREAD_LIST_LIMIT: 50,
  loadCommentAccess: access,
  loadCommentThreads: vi.fn(),
}))
vi.mock('~/services/content.server', () => ({
  fetchArtifactSource: fetchSource,
}))
vi.mock('~/services/shareables.server', () => ({
  listArtifactVersions: history,
  listOwnedArtifactVersions: history,
}))
import { getArtifactReadback } from './artifact-readback-service.server'

beforeEach(() => {
  access.mockReset().mockResolvedValue({
    artifactKind: 'html_page',
    currentVersionId: 'v1',
    r2Key: 'artifacts/s1/v1/index.html',
    visibility: 'private',
    linkExpiresAt: null,
    isOwner: true,
    workspaceId: 'ws1',
  })
  fetchSource
    .mockReset()
    .mockResolvedValue({ kind: 'ok', body: '<p>Report</p>', sizeBytes: 13 })
  const row = {
    versionId: 'v1',
    status: 'published',
    sizeBytes: 13,
    createdAt: '2026-09-01T00:00:00Z',
    publishedAt: null,
    isCurrent: true,
    creator: {
      kind: 'human',
      name: 'Author',
      email: 'author@example.com',
      agentProfileId: null,
    },
  }
  history.mockReset().mockResolvedValue({
    versions: [
      { ...row, label: 'Cafe\u0301' },
      { ...row, versionId: 'v0', label: null, isCurrent: false },
    ],
    hasMore: false,
  })
})

for (const workspaceId of ['ws1', 'ws2']) {
  test(`labels survive readback unchanged with creator redaction for ${workspaceId}`, async () => {
    const result = await getArtifactReadback(
      {} as never,
      { workspaceId } as never,
      {
        id: 's1',
        baseUrl: 'https://artifactshare.test',
        include: ['versions'],
      },
    )
    expect(result.kind).toBe('ok')
    if (result.kind !== 'ok') throw new Error('expected ok')
    const data = ArtifactReadResponseSchema.parse(result.data)
    expect(data.versions?.[0]?.label).toBe('Cafe\u0301')
    expect(data.versions?.[1]).not.toHaveProperty('label')
    expect(data.versions?.[0]?.creator?.email).toBe(
      workspaceId === 'ws1' ? 'author@example.com' : null,
    )
  })
}

test('unauthorized read never loads labels or source', async () => {
  access.mockResolvedValue(null)
  expect(
    await getArtifactReadback({} as never, {} as never, {
      id: 's1',
      baseUrl: 'https://artifactshare.test',
      include: ['versions'],
    }),
  ).toEqual({ kind: 'not-found' })
  expect(history).not.toHaveBeenCalled()
  expect(fetchSource).not.toHaveBeenCalled()
})
