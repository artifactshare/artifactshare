import { ArtifactVersionUpdateResponseSchema } from '@artifactshare/contract'
import { beforeEach, expect, test, vi } from 'vitest'
import type { CliAuthority } from '~/services/cli-authority.server'
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

test.each([true, false])(
  'static-site adapter keeps publisher URL private and human link URLs visibility-aware (%s)',
  async (publisher) => {
    const query = {
      select: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      executeTakeFirstOrThrow: vi
        .fn()
        .mockResolvedValue({ visibility: 'link' }),
    }
    const selectFrom = vi.fn(() => query)
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
    const result = await staticSiteRequestContent(request, {
      expectedContainerId: null,
    }).session.publish({
      db: { selectFrom },
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
    expect(response.shareUrl).toBe(
      publisher
        ? 'https://example.test/a/site123abc'
        : 'https://site123abc.localhost:5173/',
    )
    expect(selectFrom).toHaveBeenCalledTimes(publisher ? 0 : 1)
  },
)
