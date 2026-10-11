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
import { staticSiteRequestContent } from './static-site-request.server'

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
