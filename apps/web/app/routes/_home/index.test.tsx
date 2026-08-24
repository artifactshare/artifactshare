import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { ReactNode } from 'react'
import type { Kysely } from 'kysely'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { createMigratedInMemoryDb } from '~/test/sqlite-fixture'
import { userContext } from '~/middleware/context'
import type { SessionUser } from '~/lib/user'
import type { DB } from '~/types/db'

const dbHolder = vi.hoisted(() => ({ db: null as unknown }))
const layoutContext = vi.hoisted(() => ({
  signedIn: true as boolean,
}))
vi.mock('~/services/db.server', () => ({ createDb: () => dbHolder.db }))
vi.mock('cloudflare:workers', () => ({ env: {} }))
vi.mock('react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router')>()
  return {
    ...actual,
    Link: ({ children, to, ...props }: { children: ReactNode; to: string }) => (
      <a href={to} {...props}>
        {children}
      </a>
    ),
    useLocation: () => ({ state: null }),
    useRouteLoaderData: () => ({ maintenance: false }),
    useOutletContext: () =>
      layoutContext.signedIn
        ? {
            signedIn: true,
            workspaceId: 'ws-a',
            workspaceName: 'example.com',
            user: {
              id: 'u-owner',
              email: 'owner@example.com',
              name: 'Owner',
              image: null,
            },
            defaultVisibility: 'workspace',
            workspaceHd: 'example.com',
            availableVisibilities: ['private', 'workspace'],
            selfUploadEnabled: true,
            openUploadDialog: () => {},
          }
        : { signedIn: false },
  }
})
vi.mock('~/hooks/use-t', () => ({
  useT: () => ({
    locale: 'en',
    t: (key: string, vars?: Record<string, string>) => {
      if (key === 'project.homeTitle') return `${vars?.name ?? ''} home`
      const labels: Record<string, string> = {
        'project.location': 'Location',
        'tb.home': 'Home',
        'home.filesDescription': 'Your files',
        'home.recentActivity': 'Recent activity',
        'home.searchAll': 'Search your files',
        'home.inboxLabel': 'Home',
        'project.projects': 'Projects',
        'home.allProjects': 'All projects',
        'home.seeAll': 'See all',
        'upload.cta.primary': 'Upload',
        'home.viewedByInline_one': `${vars?.title ?? ''} viewed by ${vars?.count ?? ''} person`,
        'home.viewedByInline_other': `${vars?.title ?? ''} viewed by ${vars?.count ?? ''} people`,
        'home.actorCommentedInline': `${vars?.actor ?? ''} commented on ${vars?.title ?? ''}`,
        'home.actorCommentedCountInline': `${vars?.actor ?? ''} commented on ${vars?.title ?? ''} ${vars?.count ?? ''} times`,
        'home.publishedRangeInline': `${vars?.title ?? ''} updated from v${vars?.start ?? ''}–v${vars?.end ?? ''}`,
      }
      return labels[key] ?? key
    },
    tPlural: (key: string, n: number) => `${n} files`,
  }),
}))
vi.mock('~/hooks/use-hydrated', () => ({ useHydrated: () => false }))
vi.mock('./+components/landing', () => ({
  Landing: () => <div data-landing="true">Landing</div>,
}))
import Home, { loader, meta } from './index'
import { landingMeta } from '~/lib/landing-meta'

const TS = '2026-06-14T00:00:00.000Z'

function sessionUser(over: Partial<SessionUser> & Pick<SessionUser, 'id'>) {
  return {
    email: `${over.id}@example.com`,
    name: over.id,
    image: null,
    workspaceId: 'ws-a',
    hd: 'example.com',
    locale: null,
    ...over,
  } as SessionUser
}

async function loadHome(viewer: SessionUser | null, path = '/') {
  const context = new Map()
  context.set(userContext, viewer)
  return await loader({
    request: new Request(`https://artifactshare.com${path}`),
    context,
  } as never)
}

describe('/ home loader', () => {
  let db: Kysely<DB>
  beforeEach(async () => {
    ;({ db } = createMigratedInMemoryDb())
    dbHolder.db = db
    await seed(db)
  })
  afterEach(async () => {
    await db.destroy()
  })

  test('returns the current home payload', async () => {
    const result = await loadHome(sessionUser({ id: 'u-owner' }))
    expect(result.signedIn).toBe(true)
    if (!result.signedIn) return
    expect(result.rail?.files.length).toBeLessThanOrEqual(5)
    expect(result.unopened?.files.map((file) => file.id)).toEqual([
      's-owner-private',
      's-owner-project',
      's-owner-workspace',
    ])
    expect(result.recent?.rows).toBeDefined()
  })

  test('unsigned users get signedIn false', async () => {
    const result = await loadHome(null)
    expect(result).toEqual({ signedIn: false })
  })
})

describe('/ home page', () => {
  beforeEach(() => {
    layoutContext.signedIn = true
  })

  test.each([
    ['en', 'https://artifactshare.com/'],
    ['ja', 'https://artifactshare.com/ja'],
  ] as const)(
    'landing metadata is self-canonical for %s',
    (locale, canonical) => {
      const metadata = locale === 'en' ? meta() : landingMeta('ja')
      expect(metadata).toContainEqual({
        tagName: 'link',
        rel: 'canonical',
        href: canonical,
      })
      expect(metadata).toContainEqual({
        tagName: 'link',
        rel: 'alternate',
        hrefLang: 'en',
        href: 'https://artifactshare.com/',
      })
      expect(metadata).toContainEqual({
        tagName: 'link',
        rel: 'alternate',
        hrefLang: 'ja',
        href: 'https://artifactshare.com/ja',
      })
      expect(metadata).toContainEqual({
        tagName: 'link',
        rel: 'alternate',
        hrefLang: 'x-default',
        href: 'https://artifactshare.com/',
      })
      expect(metadata).toContainEqual({
        property: 'og:url',
        content: canonical,
      })
    },
  )

  test('renders landing when layout context is unsigned', () => {
    layoutContext.signedIn = false
    const html = renderToStaticMarkup(
      createElement(Home, { loaderData: { signedIn: false } } as never),
    )
    layoutContext.signedIn = true
    expect(html).toContain('data-landing="true"')
    expect(html).not.toContain('Recent activity')
  })

  test('renders the rail destinations without global activity links', () => {
    const html = renderToStaticMarkup(
      createElement(Home, {
        loaderData: {
          signedIn: true,
          recent: {
            rows: [],
            relation: 'all',
            unread: false,
            total: 0,
            historyCardinality: 0,
            error: false,
            now: TS,
          },
          rail: {
            files: [],
            projects: [],
            errors: { files: false, projects: false },
          },
        },
      } as never),
    )
    expect(html.match(/<h1[^>]*>[^<]+<\/h1>/g)).toHaveLength(1)
    expect(html).not.toContain('aria-label="Location"')
    expect(html).toContain('href="/files"')
    expect(html).toContain('href="/projects"')
    expect(html).toContain('href="/recent"')
    expect(html).not.toContain('href="/activity')
    expect(html).not.toContain('feed=')
  })

  test('empty home has no global activity empty state', () => {
    const html = renderToStaticMarkup(
      createElement(Home, {
        loaderData: {
          signedIn: true,
          recent: {
            rows: [],
            relation: 'all',
            unread: false,
            total: 0,
            historyCardinality: 0,
            error: false,
            now: TS,
          },
          rail: {
            files: [],
            projects: [],
            errors: { files: false, projects: false },
          },
        },
      } as never),
    )
    expect(html).not.toContain('home.noActivity')
    expect(html).not.toContain('feed=')
  })

  test('rail errors remain without a global activity error region', () => {
    const html = renderToStaticMarkup(
      createElement(Home, {
        loaderData: {
          signedIn: true,
          recent: {
            rows: [],
            relation: 'all',
            unread: false,
            total: 0,
            historyCardinality: 0,
            error: false,
            now: TS,
          },
          rail: {
            files: [],
            projects: [],
            errors: { files: true, projects: true },
          },
        },
      } as never),
    )
    expect(html).toContain('home.reload')
    expect(html).toContain('home.railError')
    expect(html).not.toContain('home.feedError')
  })
})

async function seed(db: Kysely<DB>) {
  await db
    .insertInto('workspaces')
    .values([workspace('ws-a', 'example.com')])
    .execute()
  await db
    .insertInto('users')
    .values([
      user('u-owner', 'owner@example.com', 'ws-a'),
      user('u-other', 'other@example.com', 'ws-a'),
    ])
    .execute()
  await db
    .insertInto('artifact_containers')
    .values([
      inbox('inbox-owner', 'ws-a', 'u-owner'),
      inbox('inbox-other', 'ws-a', 'u-other'),
      project('project-owner', 'ws-a', 'u-owner', 'Owner Project'),
      project('project-other', 'ws-a', 'u-other', 'Other Project'),
    ])
    .execute()
  await db
    .insertInto('shareables')
    .values([
      shareable(
        's-owner-private',
        'ws-a',
        'u-owner',
        'inbox-owner',
        'private',
        '2026-06-12T00:00:00.000Z',
      ),
      shareable(
        's-owner-workspace',
        'ws-a',
        'u-owner',
        'inbox-owner',
        'workspace',
        '2026-06-13T00:00:00.000Z',
      ),
      shareable(
        's-owner-project',
        'ws-a',
        'u-owner',
        'project-owner',
        'workspace',
        '2026-06-14T00:00:00.000Z',
      ),
      shareable(
        's-other-workspace',
        'ws-a',
        'u-other',
        'inbox-other',
        'workspace',
        '2026-06-15T00:00:00.000Z',
      ),
      shareable(
        's-other-project',
        'ws-a',
        'u-other',
        'project-other',
        'workspace',
        '2026-06-16T00:00:00.000Z',
      ),
    ])
    .execute()
  await db
    .insertInto('versions')
    .values(
      [
        ['s-owner-private', 'u-owner'],
        ['s-owner-workspace', 'u-owner'],
        ['s-owner-project', 'u-owner'],
        ['s-other-workspace', 'u-other'],
        ['s-other-project', 'u-other'],
      ].map(([shareableId, createdById]) => ({
        id: `${shareableId}-published`,
        shareable_id: shareableId,
        artifact_kind: 'html_page' as const,
        status: 'published' as const,
        entrypoint_path: '/index.html',
        r2_key: `test/${shareableId}`,
        size_bytes: 1,
        sha256: `sha-${shareableId}`,
        created_by_id: createdById,
        created_at: TS,
        published_at: TS,
      })),
    )
    .execute()
}

function workspace(id: string, hd: string) {
  return {
    id,
    hd,
    name: id,
    created_at: TS,
    plan: 'free' as const,
    storage_quota_bytes: 104857600,
    storage_used_bytes: 0,
    storage_updated_at: TS,
  }
}

function user(id: string, email: string, workspaceId: string) {
  return {
    id,
    email,
    email_verified: 1,
    name: id,
    image: null,
    created_at: TS,
    updated_at: TS,
    workspace_id: workspaceId,
    locale: null,
  }
}

function inbox(id: string, workspaceId: string, ownerUserId: string) {
  return {
    id,
    workspace_id: workspaceId,
    kind: 'inbox' as const,
    owner_user_id: ownerUserId,
    created_by_id: ownerUserId,
    name: '未整理',
    description: null,
    base_visibility: 'workspace' as const,
    archived_at: null,
    created_at: TS,
    updated_at: TS,
  }
}

function project(
  id: string,
  workspaceId: string,
  createdById: string,
  name: string,
) {
  return {
    id,
    workspace_id: workspaceId,
    kind: 'project' as const,
    owner_user_id: null,
    created_by_id: createdById,
    name,
    description: null,
    base_visibility: 'workspace' as const,
    archived_at: null,
    created_at: TS,
    updated_at: TS,
  }
}

function shareable(
  id: string,
  workspaceId: string,
  ownerUserId: string,
  containerId: string,
  visibility: 'private' | 'workspace',
  updatedAt: string,
) {
  return {
    id,
    workspace_id: workspaceId,
    owner_user_id: ownerUserId,
    slug: null,
    name: id,
    derived_title: null,
    title_override: null,
    description: null,
    artifact_kind: 'html_page' as const,
    visibility,
    current_version_id: `${id}-published`,
    container_id: containerId,
    created_at: TS,
    updated_at: updatedAt,
    last_accessed_at: null,
  }
}
