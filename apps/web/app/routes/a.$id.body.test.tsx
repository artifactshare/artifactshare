import { beforeEach, expect, test, vi } from 'vitest'
import { verifySandboxTokenDetailed } from '~/lib/sandbox-token'

const state = vi.hoisted(() => ({
  user: { id: 'u1' } as { id: string } | null,
  linkHost: false,
  access: true,
  anonymous: 'allowed',
  lowTrust: false,
  stage: 'usercontent',
  kind: 'html_page',
  versionStatus: 'published',
  publishedAt: '2026-01-01T00:00:00.000Z' as string | null,
  current: 'v1',
}))
vi.mock('cloudflare:workers', () => ({
  env: {
    APP_ENV: 'production',
    BETTER_AUTH_SECRET: 'test',
    get ARTIFACT_DELIVERY_STAGE() {
      return state.stage
    },
  },
}))
vi.mock('~/services/link-trust.server', () => ({
  anonymousLinkLowTrust: () => Promise.resolve(state.lowTrust),
}))
vi.mock('~/modules/access', () => ({
  facts: () =>
    Promise.resolve({ viewerUserId: 'u1', artifactWorkspaceId: 'ws1' }),
}))
vi.mock('~/services/access.server', () => ({
  viewerAccessAllowed: () => state.access,
}))
vi.mock('~/services/link-sharing.server', () => ({
  checkAnonymousLinkAccess: () => Promise.resolve({ kind: state.anonymous }),
}))
vi.mock('~/services/db.server', () => ({
  createDb: () => ({
    selectFrom(table: string) {
      const predicates: Array<(row: Record<string, unknown>) => boolean> = []
      const query = {
        leftJoin: () => query,
        select: () => query,
        where(column: string, operator: string, value: unknown) {
          if (operator !== '=' && operator !== 'is not') {
            throw new Error(`Unsupported mock operator: ${operator}`)
          }
          predicates.push((row) =>
            operator === '=' ? row[column] === value : row[column] !== value,
          )
          return query
        },
        executeTakeFirst: async () =>
          table === 'versions'
            ? ['v1', 'v2']
                .map((id) => ({
                  id,
                  shareable_id: 'abc123def4',
                  status: state.versionStatus,
                  published_at: state.publishedAt,
                  r2_key: 'body-key',
                  entrypoint_path: '/index.html',
                  artifact_kind: state.kind,
                }))
                .find((row) => predicates.every((predicate) => predicate(row)))
            : {
                id: 'abc123def4',
                workspace_id: 'ws1',
                name: 'Protected title',
                visibility: 'link',
                current_version_id: state.current,
                r2_key: 'body-key',
                version_artifact_kind: state.kind,
              },
      }
      return query
    },
  }),
}))
import { linkDomainContext, userContext } from '~/middleware/context'
import { loader } from './a.$id.body'

function args(version = 'v1', method = 'GET', id = 'abc123def4') {
  const context = new Map([
    [userContext, state.user],
    [linkDomainContext, state.linkHost ? { shareableId: 'abc123def4' } : null],
  ] as [unknown, unknown][])
  return {
    context,
    params: { id },
    request: new Request(
      `https://${state.linkHost ? 'abc123def4.artifactshare.link' : 'artifactshare.com'}/a/${id}/body?version=${version}`,
      { method },
    ),
  } as never
}
beforeEach(() =>
  Object.assign(state, {
    user: { id: 'u1' },
    linkHost: false,
    access: true,
    anonymous: 'allowed',
    lowTrust: false,
    stage: 'usercontent',
    kind: 'html_page',
    versionStatus: 'published',
    publishedAt: '2026-01-01T00:00:00.000Z' as string | null,
    current: 'v1',
  }),
)

test.each(['html_page', 'markdown_page'])(
  'opens pinned %s history with independent 60-second tokens',
  async (kind) => {
    state.kind = kind
    state.current = 'v2'
    const tokens = []
    for (let i = 0; i < 2; i++) {
      const response = await loader(args())
      expect(response.status).toBe(302)
      expect(response.headers.get('Cache-Control')).toContain('no-store')
      const token = new URL(response.headers.get('Location')!).searchParams.get(
        '__as_token',
      )!
      const verified = await verifySandboxTokenDetailed(token, 'test')
      expect(verified.ok).toBe(true)
      if (!verified.ok) throw new Error('Expected signed token')
      expect(verified.payload).toMatchObject({
        standalone: true,
        uid: 'u1',
        vid: 'v1',
      })
      expect(
        verified.payload.exp - Math.floor(Date.now() / 1000),
      ).toBeGreaterThanOrEqual(59)
      expect(
        verified.payload.exp - Math.floor(Date.now() / 1000),
      ).toBeLessThanOrEqual(60)
      tokens.push(verified.payload.jti)
    }
    expect(tokens[0]).not.toBe(tokens[1])
  },
)

test.each([false, true])(
  'anonymous host=%s requires current pin and non-low-trust authority',
  async (linkHost) => {
    state.user = null
    state.linkHost = linkHost
    expect((await loader(args())).status).toBe(302)
    for (const change of [
      { lowTrust: true },
      { current: 'v2' },
      { anonymous: 'expired' },
      { anonymous: 'suspended' },
      { anonymous: 'not-link' },
    ]) {
      Object.assign(
        state,
        { lowTrust: false, current: 'v1', anonymous: 'allowed' },
        change,
      )
      const response = await loader(args())
      expect(response.status).toBe(404)
      expect(response.headers.has('Location')).toBe(false)
      const body = await response.text()
      expect(body).toContain('Return to the viewer')
      expect(body).toContain('<section lang="ja">')
      expect(body).toContain(
        '本文を表示できないか、閲覧権限がなくなっています。',
      )
      expect(body).toContain('ビューアーに戻る</a>')
      expect(body).not.toMatch(/body-key|Protected title|__as_token/)
    }
  },
)

test.each([
  ['pending', '2026-01-01T00:00:00.000Z', 404],
  ['published', null, 404],
  ['published', '2026-01-01T00:00:00.000Z', 302],
] as const)(
  'version status=%s and published_at=%s returns %s',
  async (versionStatus, publishedAt, expectedStatus) => {
    Object.assign(state, { versionStatus, publishedAt })
    const response = await loader(args())
    expect(response.status).toBe(expectedStatus)
    if (expectedStatus === 302) {
      const token = new URL(response.headers.get('Location')!).searchParams.get(
        '__as_token',
      )!
      expect(await verifySandboxTokenDetailed(token, 'test')).toMatchObject({
        ok: true,
        payload: { vid: 'v1', standalone: true },
      })
    } else {
      expect(response.headers.has('Location')).toBe(false)
      expect(await response.text()).not.toMatch(
        /body-key|Protected title|__as_token/,
      )
    }
  },
)

test.each([
  ['access removed', { access: false }, 'v1', 'GET', 404],
  ['nonexistent', {}, 'missing', 'GET', 404],
  ['static site', { kind: 'static_site' }, 'v1', 'GET', 404],
  ['unsupported', { kind: 'pdf' }, 'v1', 'GET', 404],
  ['unavailable', { stage: 'disabled' }, 'v1', 'GET', 503],
  ['missing pin', {}, '', 'GET', 400],
  ['HEAD', {}, 'v1', 'HEAD', 405],
  ['POST', {}, 'v1', 'POST', 405],
] as const)(
  'denies %s without credentials or content',
  async (_name, changes, version, method, status) => {
    Object.assign(state, changes)
    const response = await loader(args(version, method))
    expect(response.status).toBe(status)
    expect(response.headers.has('Location')).toBe(false)
    expect(await response.text()).not.toMatch(
      /body-key|Protected title|__as_token/,
    )
  },
)

test('link host cannot address another artifact', async () => {
  state.linkHost = true
  expect((await loader(args('v1', 'GET', 'other12345'))).status).toBe(404)
})
