import { ArtifactVersionUpdateResponseSchema } from '@artifactshare/contract'
import { beforeEach, expect, test, vi } from 'vitest'
import type { CliAuthority } from '~/services/cli-authority.server'
import { createMigratedInMemoryDb } from '~/test/sqlite-fixture'
import type { StaticSiteContentSessionContext } from './index'

vi.mock('cloudflare:workers', () => ({ env: { APP_ENV: 'development' } }))

const beginCreate = vi.hoisted(() => vi.fn())
const beginUpdate = vi.hoisted(() => vi.fn())
vi.mock('~/services/shareables.server', () => ({
  beginStaticSiteBundleUploadSession: beginCreate,
  beginStaticSiteBundleVersionUploadSession: beginUpdate,
}))
import {
  staticSiteRequestContent,
  staticSitePublishResponse,
} from './static-site-request.server'

beforeEach(() => {
  vi.clearAllMocks()
})
test.each(['create', 'update'] as const)(
  'rejects unknown authority before streaming a static-site %s',
  async (kind) => {
    const request = new Request('https://example.test/api/shareables/uploads', {
      method: 'POST',
      body: 'unconsumed',
    })
    const content = staticSiteRequestContent(request, {
      expectedContainerId: null,
    })
    const result = await content.session.publish({
      authority: { kind: 'unknown' } as unknown as CliAuthority,
      target: kind === 'create' ? { kind } : { kind, artifactId: 'site123abc' },
      user: { id: 'u1', email: 'owner@example.com', workspaceId: 'ws1' },
    } as StaticSiteContentSessionContext)
    expect(result.kind).toBe('static-site-visibility-forbidden')
    expect(beginCreate).not.toHaveBeenCalled()
    expect(beginUpdate).not.toHaveBeenCalled()
    expect(request.bodyUsed).toBe(false)
  },
)

function seedArtifact(visibility: 'private' | 'link') {
  const { sqlite, db } = createMigratedInMemoryDb()
  sqlite.exec(`
    INSERT INTO workspaces (id, name, created_at) VALUES ('ws1', 'Workspace', '2026-09-01');
    INSERT INTO users (id, email, created_at, updated_at, workspace_id)
      VALUES ('u1', 'owner@example.com', '2026-09-01', '2026-09-01', 'ws1');
    INSERT INTO artifact_containers (id, workspace_id, kind, owner_user_id, created_by_id, name, created_at, updated_at)
      VALUES ('c1', 'ws1', 'inbox', 'u1', 'u1', 'Inbox', '2026-09-01', '2026-09-01');
    INSERT INTO shareables (id, workspace_id, owner_user_id, name, artifact_kind, visibility, container_id, created_at, updated_at)
      VALUES ('site123abc', 'ws1', 'u1', 'Site', 'static_site', '${visibility}', 'c1', '2026-09-01', '2026-09-01');
  `)
  return { sqlite, db }
}

test.each([
  [
    'a publisher keeps the private URL for a link artifact',
    true,
    'link',
    'https://example.test/a/site123abc',
  ],
  [
    'a human gets the sandbox URL for a link artifact',
    false,
    'link',
    'https://site123abc.localhost:5173/',
  ],
  [
    'a human gets the private URL for a private artifact',
    false,
    'private',
    'https://example.test/a/site123abc',
  ],
] as const)('%s', async (_name, publisher, visibility, shareUrl) => {
  const { sqlite, db } = seedArtifact(visibility)
  const authority = publisher
    ? ({
        kind: 'publisher',
        familyId: 'family1',
        workspaceId: 'ws1',
        publisherClientId: 'client1',
        publisherClientName: 'Reports',
      } as const)
    : null
  beginUpdate.mockResolvedValue({
    kind: 'ok',
    session: {
      fileCount: 1,
      addFile: vi.fn().mockResolvedValue({ kind: 'ok' }),
      commitVersion: vi.fn().mockResolvedValue({
        kind: 'ok',
        id: 'site123abc',
        versionId: 'v2',
        number: 2,
      }),
      abort: vi.fn(),
    },
  })
  const body = new FormData()
  body.append(
    'file',
    new File(['<h1>Report</h1>'], 'index.html', { type: 'text/html' }),
  )
  const request = new Request(
    'https://example.test/api/shareables/site123abc/versions',
    { method: 'POST', body },
  )
  try {
    const result = await staticSiteRequestContent(request, {
      expectedContainerId: null,
    }).session.publish({
      db,
      authority,
      target: {
        kind: 'update',
        artifactId: 'site123abc',
        expectedVersionId: 'v1',
      },
      user: { id: 'u1', email: 'owner@example.com', workspaceId: 'ws1' },
    } as unknown as StaticSiteContentSessionContext)
    expect(result.kind).toBe('static-site-update-ok')
    const response = ArtifactVersionUpdateResponseSchema.parse(
      await staticSitePublishResponse(request, result).json(),
    )
    expect(response.shareUrl).toBe(shareUrl)
  } finally {
    sqlite.close()
  }
})
