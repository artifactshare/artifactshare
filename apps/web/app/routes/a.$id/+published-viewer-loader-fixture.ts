import { vi } from 'vitest'
import {
  ctxContext,
  linkDomainContext,
  userContext,
} from '~/middleware/context'
import { loader } from './+loader.server'

const db = vi.hoisted(() => ({ selectFrom: vi.fn() }))
// A synthetic secret; kept out of the env literal because this fixture is not
// a test file, which is where the public scan accepts synthetic secrets.
const testAuthSecret = vi.hoisted(
  () => 'test-secret-with-enough-entropy-for-hmac',
)

// Keep the loader and its publication/version mapping real. Only external
// services and persistence are replaced so this fixture also runs in a browser.
vi.mock('cloudflare:workers', () => ({
  env: {
    APP_ENV: 'production',
    BETTER_AUTH_SECRET: testAuthSecret,
    BETTER_AUTH_URL: 'https://artifactshare.com',
    VIEW_DEDUP: {},
    ARTIFACT_LIVE: {},
  },
}))
vi.mock('~/services/db.server', () => ({ createDb: () => db }))
vi.mock('~/modules/access', async (original) => ({
  // Loader dependencies also import SQL helpers from this module. Preserve
  // those exports so the browser can link the complete module graph.
  ...(await original<typeof import('~/modules/access')>()),
  isWorkspaceAccessRevoked: () => Promise.resolve(false),
  facts: (_db: unknown, input: { viewerUserId: string | null }) =>
    Promise.resolve({
      visibility: 'link',
      viewerUserId: input.viewerUserId,
      ownerUserId: 'u1',
      viewerWorkspaceId: 'ws1',
      artifactWorkspaceId: 'ws1',
      viewerEmailVerified: true,
      anonymousLinkAllowed: input.viewerUserId === null,
      linkSuspended: false,
      isTeamAdmin: false,
      hasShareableGrant: input.viewerUserId !== null,
      workspaceAccessRevoked: false,
    }),
}))
vi.mock('~/services/shareables.server', () => ({
  canUpdateShareableVersion: () => Promise.resolve(false),
  listGrants: () => Promise.resolve({ kind: 'ok', grants: [] }),
}))
vi.mock('~/services/comments.server', () => ({
  commentAccessFromVerifiedShareable: () =>
    Promise.resolve({
      isTeamWorkspaceAdmin: false,
    }),
  latestOtherCommentCreatedAt: () => Promise.resolve(null),
  loadCommentThreads: () => Promise.resolve([]),
}))
vi.mock('~/services/viewer-list.server', () => ({
  countShareableViewers: () =>
    Promise.resolve({
      requesterEligible: false,
      viewerCount: 0,
    }),
}))
vi.mock('~/services/access-requests.server', () => ({
  getRequesterAccessRequestStatus: () => Promise.resolve(null),
}))
vi.mock('~/services/views.server', () => ({
  anonymousViewIdentifier: () =>
    Promise.resolve({
      identifier: { kind: 'anon', id: 'abc123def4' },
      cookieHeader: null,
    }),
  recordViewerRecency: () => Promise.resolve(undefined),
  recordViewAndNotifyViewCount: () => Promise.resolve({ counted: true }),
}))
vi.mock('~/services/link-abuse-signals.server', () => ({
  logLinkAbuseSignalFailure: vi.fn(),
  recordAnonymousViewSignalAndMaybeJudge: () => Promise.resolve(undefined),
}))
vi.mock('~/services/workspace-domain-claims.server', () => ({
  findWorkspaceIdByDomainClaim: () => Promise.resolve(null),
}))
vi.mock('~/services/viewer-revisit.server', () => ({
  loadViewerRevisitContext: () => Promise.resolve(null),
}))
vi.mock('~/services/dev-screen-state.server', () => ({
  isDevScreenStateRequest: () => false,
}))

function query(first: unknown, rows: unknown[] = []) {
  const chain: Record<string, unknown> = {
    executeTakeFirst: () => Promise.resolve(first),
    execute: () => Promise.resolve(rows),
  }
  for (const method of [
    'innerJoin',
    'leftJoin',
    'select',
    'where',
    'orderBy',
    'limit',
    'groupBy',
    'as',
  ]) {
    chain[method] = () => chain
  }
  return chain
}

export async function loadPublishedViewer({
  scheduled,
  persona,
  historical,
  locale,
}: {
  scheduled: boolean
  persona: 'owner' | 'member' | 'anonymous'
  historical: boolean
  locale: 'en' | 'ja'
}): Promise<Extract<Awaited<ReturnType<typeof loader>>, { kind: 'ok' }>> {
  const publishedAt = '2026-06-02T10:30:00.000Z'
  const previousPublishedAt = '2026-06-01T10:30:00.000Z'
  const publisherClientId = scheduled ? 'client1' : null
  const shareable = {
    id: 'abc123def4',
    workspace_id: 'ws1',
    owner_user_id: 'u1',
    name: 'Report.html',
    derived_title: null,
    title_override: null,
    description: null,
    visibility: 'link',
    current_version_id: 'v1',
    current_published_at: publishedAt,
    created_by_publisher_client_id: publisherClientId,
    owner_email: 'owner@example.com',
    owner_name: 'Owner',
    owner_image: null,
    owner_kind: 'human',
    owner_created_at: '2026-01-01T00:00:00.000Z',
    artifact_workspace_plan: 'plus',
    r2_key: 'artifacts/abc123def4/v1/index.html',
    entrypoint_path: '/index.html',
    version_artifact_kind: 'html_page',
  }
  db.selectFrom.mockImplementation((table: string) => {
    if (table === 'shareables') return query(shareable)
    if (table === 'versions')
      return query(
        {
          id: historical ? 'v0' : 'v1',
          artifact_kind: 'html_page',
          entrypoint_path: '/index.html',
          r2_key: `artifacts/abc123def4/${historical ? 'v0' : 'v1'}/index.html`,
          published_at: historical ? previousPublishedAt : publishedAt,
          count: 2,
        },
        ['v1', 'v0'].map((id, index) => ({
          id,
          number: 2 - index,
          createdAt: index === 0 ? publishedAt : previousPublishedAt,
          publisherClientId,
          sizeBytes: 128,
        })),
      )
    if (table === 'workspaces' || table === 'workspace_members')
      return query(undefined)
    throw new Error(`Unexpected published viewer query: ${table}`)
  })
  const context = new Map()
  context.set(
    userContext,
    persona === 'anonymous'
      ? null
      : {
          id: persona === 'owner' ? 'u1' : 'u2',
          email:
            persona === 'owner' ? 'owner@example.com' : 'member@example.com',
          name: persona === 'owner' ? 'Owner' : 'Member',
          image: null,
          workspaceId: 'ws1',
          hd: 'example.com',
          locale,
        },
  )
  if (persona === 'anonymous')
    context.set(linkDomainContext, { shareableId: shareable.id })
  const followUps: Promise<unknown>[] = []
  context.set(ctxContext, {
    waitUntil: (work: Promise<unknown>) => followUps.push(work),
  })
  const result = await loader({
    params: { id: shareable.id },
    request: new Request(
      `https://artifactshare.com/a/${shareable.id}${historical ? '?version=v0' : ''}`,
    ),
    context,
  } as never)
  await Promise.all(followUps)
  if (result.kind !== 'ok') throw new Error('Expected a published HTML viewer')
  return result
}
