const selectVersion = vi.hoisted(() => vi.fn())
vi.mock('./artifact-version-selection.server', () => ({
  selectArtifactVersion: selectVersion,
}))
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
import { loadCommentThreads } from './comments.server'
import { getArtifactReadback } from './artifact-readback-service.server'

beforeEach(() => {
  selectVersion.mockReset()
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

test('included comments retain stored text metadata through the response contract', async () => {
  vi.mocked(loadCommentThreads).mockResolvedValue([
    {
      id: 't1',
      status: 'open',
      messageCount: 0,
      replyCount: 0,
      olderCursor: null,
      createdAt: '2026-09-01T00:00:00Z',
      updatedAt: '2026-09-01T00:00:00Z',
      resolvedAt: null,
      canResolve: true,
      messages: [],
      subject: {
        kind: 'text',
        quotedText: 'word',
        prefixText: 'lead ',
        suffixText: '',
        state: 'orphaned',
        positionState: 'needs-check',
        versionId: null,
        selectorFormat: 'normalized-v1',
        ambiguousAtCreation: false,
        targetPath: '/index.html',
        textStart: null,
        textEnd: null,
        cssPath: 'p',
      },
    },
  ])
  const result = await getArtifactReadback(
    {} as never,
    { workspaceId: 'ws1' } as never,
    {
      id: 's1',
      baseUrl: 'https://artifactshare.test',
      include: ['comments'],
    },
  )
  if (result.kind !== 'ok') throw new Error('expected ok')
  expect(
    ArtifactReadResponseSchema.parse(result.data).comments?.[0].anchor,
  ).toEqual({
    kind: 'text',
    quoted_text: 'word',
    state: 'orphaned',
    position_state: 'needs-check',
    quote_before: 'lead ',
    quote_after: '',
    version_id: null,
    ambiguous_at_creation: false,
  })
})

for (const isOwner of [true, false]) {
  for (const [current, selected, format] of [
    ['html_page', 'markdown_page', 'markdown'],
    ['markdown_page', 'html_page', 'html'],
  ]) {
    test(`historical source uses selected format for owner=${isOwner} ${format}`, async () => {
      access.mockResolvedValue({
        artifactKind: current,
        currentVersionId: 'v2',
        r2Key: 'current',
        visibility: 'workspace',
        isOwner,
        workspaceId: 'ws1',
      })
      selectVersion.mockResolvedValue({
        kind: 'ok',
        version: { id: 'v1', artifact_kind: selected, r2_key: 'old' },
      })
      fetchSource.mockResolvedValue({
        kind: 'ok',
        body: 'old source',
        sizeBytes: 10,
      })
      const result = await getArtifactReadback(
        {} as never,
        { workspaceId: 'ws1' } as never,
        {
          id: 's1',
          version_id: 'v1',
          baseUrl: 'https://artifactshare.test',
          include: ['versions'],
        },
      )
      expect(result).toMatchObject({
        kind: 'ok',
        data: { version_id: 'v1', format, content: 'old source' },
      })
      expect(fetchSource).toHaveBeenCalledWith('old')
      if (!isOwner && result.kind === 'ok')
        expect(result.data.versions).toBeUndefined()
    })
  }
}
test('access denial precedes version and tombstone lookup', async () => {
  access.mockResolvedValue(null)
  expect(
    await getArtifactReadback({} as never, {} as never, {
      id: 's1',
      version_id: 'removed',
      baseUrl: 'https://artifactshare.test',
    }),
  ).toEqual({ kind: 'not-found' })
  expect(selectVersion).not.toHaveBeenCalled()
  expect(fetchSource).not.toHaveBeenCalled()
})
for (const kind of ['not-found', 'version-removed']) {
  test(`historical ${kind} never reads current storage`, async () => {
    selectVersion.mockResolvedValue({ kind })
    expect(
      await getArtifactReadback({} as never, {} as never, {
        id: 's1',
        version_id: 'v0',
        baseUrl: 'https://artifactshare.test',
      }),
    ).toEqual({ kind })
    expect(fetchSource).not.toHaveBeenCalled()
  })
}
test('historical source continuation preserves a surrogate pair at the cap', async () => {
  const source = 'x'.repeat(199999) + '😀tail'
  selectVersion.mockResolvedValue({
    kind: 'ok',
    version: { id: 'v0', artifact_kind: 'markdown_page', r2_key: 'old' },
  })
  fetchSource.mockResolvedValue({
    kind: 'ok',
    body: source,
    sizeBytes: source.length + 2,
  })
  const args = {
    id: 's1',
    version_id: 'v0',
    baseUrl: 'https://artifactshare.test',
  }
  const first = await getArtifactReadback({} as never, {} as never, args)
  if (first.kind !== 'ok' || first.data.next_offset === null)
    throw new Error('expected chunk')
  const second = await getArtifactReadback({} as never, {} as never, {
    ...args,
    offset: first.data.next_offset,
  })
  if (second.kind !== 'ok') throw new Error('expected continuation')
  expect(first.data.content + second.data.content).toBe(source)
  expect(first.data.version_id).toBe('v0')
  expect(second.data.version_id).toBe('v0')
  expect(first.data.content.length).toBe(199999)
})
test('missing historical storage does not fall back to current content', async () => {
  selectVersion.mockResolvedValue({
    kind: 'ok',
    version: { id: 'v0', artifact_kind: 'markdown_page', r2_key: 'old' },
  })
  fetchSource.mockResolvedValue({ kind: 'not-found' })
  expect(
    await getArtifactReadback({} as never, {} as never, {
      id: 's1',
      version_id: 'v0',
      baseUrl: 'https://artifactshare.test',
    }),
  ).toEqual({ kind: 'source-unavailable' })
  expect(fetchSource.mock.calls).toEqual([['old']])
})

for (const selectedStatic of [true, false]) {
  test(`historical reads reject static sites (selected=${selectedStatic})`, async () => {
    if (selectedStatic)
      selectVersion.mockResolvedValue({
        kind: 'ok',
        version: { id: 'v0', artifact_kind: 'static_site', r2_key: 'old' },
      })
    else access.mockResolvedValue({ artifactKind: 'static_site' })
    expect(
      await getArtifactReadback({} as never, {} as never, {
        id: 's1',
        version_id: 'v0',
        baseUrl: 'https://artifactshare.test',
      }),
    ).toEqual({ kind: 'unsupported-kind', artifactKind: 'static_site' })
    expect(fetchSource).not.toHaveBeenCalled()
  })
}
