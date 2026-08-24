import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { TooltipProvider } from '~/components/ui/tooltip'
import { verifySandboxToken } from '~/lib/sandbox-token'
import { ctxContext, userContext } from '~/middleware/context'

const commentLiveMock = vi.hoisted(() => ({
  getByName: vi.fn(),
}))

vi.mock('cloudflare:workers', () => ({
  env: {
    APP_ENV: 'production',
    BETTER_AUTH_SECRET: 'test-secret-with-enough-entropy-for-hmac',
    VIEW_DEDUP: {},
    ARTIFACT_LIVE: commentLiveMock,
  },
}))

const dbMock = vi.hoisted(() => ({
  selectFrom: vi.fn(),
  updateTable: vi.fn(),
}))
const viewerDisplayCheckMock = vi.hoisted(() => vi.fn())
const listGrantsMock = vi.hoisted(() => vi.fn())
const countShareableViewersMock = vi.hoisted(() => vi.fn())
const recordViewerRecencyMock = vi.hoisted(() => vi.fn())
const recordViewAndNotifyViewCountMock = vi.hoisted(() => vi.fn())
const anonymousViewIdentifierMock = vi.hoisted(() => vi.fn())

vi.mock('~/services/db.server', () => ({
  createDb: () => dbMock,
}))
vi.mock('~/services/access.server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('~/services/access.server')>()),
  viewerDisplayCheck: viewerDisplayCheckMock,
}))
vi.mock('~/services/shareables.server', () => ({
  listGrants: listGrantsMock,
}))
vi.mock('~/services/viewer-list.server', () => ({
  countShareableViewers: countShareableViewersMock,
}))
vi.mock('~/services/views.server', () => ({
  anonymousViewIdentifier: anonymousViewIdentifierMock,
  recordViewerRecency: recordViewerRecencyMock,
  recordViewAndNotifyViewCount: recordViewAndNotifyViewCountMock,
}))

vi.mock('~/hooks/use-t', () => ({
  useT: () => ({
    locale: 'en',
    t: (key: string) =>
      ({
        'lp.invite.aiBody':
          'If you are reading this page without signing in, you cannot read the file contents.',
        'lp.invite.cliTitle': 'If you can run shell commands',
        'lp.invite.cliBody':
          'Use the CLI to open this link, then sign in with an account included in the sharing settings.',
        'lp.invite.chatTitle': 'If you cannot run commands',
        'lp.invite.chatBody':
          'Ask the user to attach the file, sign in with an allowed account, or ask the person who shared it to add access or change the sharing settings.',
        'lp.invite.commandLabel': 'Shell command',
        'lp.invite.copyCommand': 'Copy command',
        'lp.invite.copyCopied': 'Copied',
        'lp.invite.copyFailed': 'Copy failed',
      })[key] ?? key,
    tPlural: (key: string, n: number) => `${key}:${n}`,
  }),
}))

import {
  AgentHelpContent,
  buildPreauthCliOpenCommand,
  loader,
  meta,
} from './index'

describe('/a/:id loader', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    recordViewerRecencyMock.mockResolvedValue(undefined)
    countShareableViewersMock.mockResolvedValue({
      requesterEligible: false,
      viewerCount: 0,
    })
    anonymousViewIdentifierMock.mockResolvedValue({
      identifier: { kind: 'anon', id: 'anon-1', fallbackId: 'fallback-1' },
      cookieHeader: null,
    })
  })

  test('returns preauth without artifact metadata for anonymous shares', async () => {
    const shareable = {
      id: 'html123abc',
      workspace_id: 'ws1',
      owner_user_id: 'u1',
      name: 'demo.html',
      derived_title: 'Demo Report',
      title_override: null,
      description: 'A shared report',
      visibility: 'private',
      current_version_id: 'v1',
      owner_email: 'owner@example.com',
      owner_name: 'Owner',
      owner_image: null,
      r2_key: 'artifacts/html123abc/v1/index.html',
      entrypoint_path: '/demo.html',
      version_artifact_kind: 'html_page',
    }
    dbMock.selectFrom.mockImplementation((table: string) => {
      if (table === 'shareables') return shareableQuery(shareable)
      throw new Error(`unexpected table ${table}`)
    })
    const context = new Map()
    context.set(userContext, null)

    const result = await loader({
      params: { id: 'html123abc' },
      request: new Request('https://artifactshare.com/a/html123abc'),
      context,
    } as never)

    expect(result).toEqual({
      kind: 'preauth',
      canonicalUrl: 'https://artifactshare.com/a/html123abc',
      artifact: {
        id: 'html123abc',
        name: null,
        derivedTitle: null,
        titleOverride: null,
        description: null,
      },
    })
    expect(viewerDisplayCheckMock).not.toHaveBeenCalled()
  })

  test('preserves a requested version through anonymous sign-in', async () => {
    const shareable = {
      id: 'html123abc',
      visibility: 'link',
      current_version_id: 'v2',
      r2_key: 'artifacts/html123abc/v2/index.html',
    }
    dbMock.selectFrom.mockImplementation((table: string) => {
      if (table === 'shareables') return shareableQuery(shareable)
      throw new Error(`unexpected table ${table}`)
    })
    const context = new Map()
    context.set(userContext, null)

    const result = await loader({
      params: { id: 'html123abc' },
      request: new Request('https://artifactshare.com/a/html123abc?version=v1'),
      context,
    } as never)

    expect(result.kind).toBe('preauth')
    if (result.kind !== 'preauth') return
    expect(result.canonicalUrl).toBe(
      'https://artifactshare.com/a/html123abc?version=v1',
    )
    expect(viewerDisplayCheckMock).not.toHaveBeenCalled()
  })

  test('renders a published historical version without recording a view', async () => {
    const shareable = {
      id: 'html123abc',
      workspace_id: 'ws1',
      owner_user_id: 'u1',
      name: 'demo.html',
      artifact_kind: 'html_page',
      derived_title: null,
      title_override: null,
      description: null,
      visibility: 'private',
      current_version_id: 'v2',
      current_published_at: '2026-05-25T00:00:00Z',
      owner_email: 'owner@example.com',
      owner_name: 'Owner',
      owner_image: null,
      owner_kind: 'human',
      r2_key: 'artifacts/html123abc/v2/index.html',
      entrypoint_path: '/index.html',
      fallback_to_index: 0,
      version_artifact_kind: 'html_page',
      view_count: 2,
      updated_at: '2026-05-25T00:00:00Z',
    }
    let versionQueryCount = 0
    dbMock.selectFrom.mockImplementation((table: string) => {
      if (table === 'shareables') return shareableQuery(shareable)
      if (table === 'versions') {
        versionQueryCount += 1
        if (versionQueryCount === 1) {
          return chain({
            executeTakeFirst: vi.fn().mockResolvedValue({
              id: 'v1',
              artifact_kind: 'html_page',
              entrypoint_path: '/index.html',
              r2_key: 'artifacts/html123abc/v1/index.html',
              fallback_to_index: 0,
              published_at: '2026-05-24T00:00:00Z',
            }),
          })
        }
        return chain({
          executeTakeFirst: vi.fn().mockResolvedValue({ count: 2 }),
          execute: vi.fn().mockResolvedValue([
            {
              id: 'v2',
              createdAt: '2026-05-25T00:00:00Z',
              sizeBytes: 256,
            },
            {
              id: 'v1',
              createdAt: '2026-05-24T00:00:00Z',
              sizeBytes: 128,
            },
          ]),
        })
      }
      if (table === 'workspaces' || table === 'workspace_members') {
        return emptyFirstQuery()
      }
      throw new Error(`unexpected table ${table}`)
    })
    viewerDisplayCheckMock.mockResolvedValue({
      kind: 'ok',
      meta: {
        modifiedTime: '2026-05-25T00:00:00Z',
        name: 'demo.html',
        mimeType: 'text/html',
        ownerEmail: 'owner@example.com',
      },
    })
    listGrantsMock.mockResolvedValue({ kind: 'ok', grants: [] })
    const context = new Map()
    context.set(userContext, {
      id: 'u1',
      email: 'owner@example.com',
      name: 'Owner',
      image: null,
      workspaceId: 'ws1',
      hd: 'example.com',
      locale: 'en',
    })
    context.set(ctxContext, { waitUntil: vi.fn() })

    const result = await loader({
      params: { id: 'html123abc' },
      request: new Request('https://artifactshare.com/a/html123abc?version=v1'),
      context,
    } as never)

    expect(result.kind).toBe('ok')
    if (result.kind !== 'ok') return
    expect(result.artifact).toMatchObject({
      currentVersionId: 'v2',
      displayedVersionId: 'v1',
      displayedVersionOrdinal: 1,
      isHistoricalVersion: true,
      canReplaceFile: true,
    })
    expect(result.canTrackView).toBe(false)
    expect(result.sandboxUrl).toContain(
      'html123abc--v-7631.sandbox.artifactshare.com',
    )
    expect(
      result.artifact.versions.find((version) => version.id === 'v1'),
    ).toMatchObject({ isDisplayed: true, isCurrent: false })
    expect(recordViewAndNotifyViewCountMock).not.toHaveBeenCalled()
    // Historical versions never query or expose the viewer list.
    expect(countShareableViewersMock).not.toHaveBeenCalled()
    expect(result.artifact).toMatchObject({
      showViewerListMetaEntry: false,
      viewerListCount: 0,
    })
  })

  test('exposes viewer-list fields for an active human member of the file workspace', async () => {
    const { context } = setupHtmlShareable()
    recordViewAndNotifyViewCountMock.mockResolvedValue(undefined)
    countShareableViewersMock.mockResolvedValue({
      requesterEligible: true,
      viewerCount: 3,
    })

    const result = await loader({
      params: { id: 'html123abc' },
      request: new Request('https://artifactshare.com/a/html123abc'),
      context,
    } as never)

    expect(result.kind).toBe('ok')
    if (result.kind !== 'ok') return
    expect(countShareableViewersMock).toHaveBeenCalledWith(expect.anything(), {
      shareableId: 'html123abc',
      requesterUserId: 'u1',
    })
    expect(result.artifact).toMatchObject({
      showViewerListMetaEntry: true,
      viewerListCount: 3,
    })
    // Internal derivation only; never serialized into the loader payload.
    expect(result.artifact).not.toHaveProperty('canViewViewerList')
  })

  test('keeps the meta entry visible with a zero count in a multi-member workspace', async () => {
    const { context } = setupHtmlShareable()
    recordViewAndNotifyViewCountMock.mockResolvedValue(undefined)
    countShareableViewersMock.mockResolvedValue({
      requesterEligible: true,
      viewerCount: 0,
    })

    const result = await loader({
      params: { id: 'html123abc' },
      request: new Request('https://artifactshare.com/a/html123abc'),
      context,
    } as never)

    expect(result.kind).toBe('ok')
    if (result.kind !== 'ok') return
    expect(result.artifact).toMatchObject({
      showViewerListMetaEntry: true,
      viewerListCount: 0,
    })
  })

  test('queries audience eligibility for a viewer from another workspace', async () => {
    setupHtmlShareable()
    recordViewAndNotifyViewCountMock.mockResolvedValue(undefined)
    const context = new Map()
    context.set(userContext, {
      id: 'u9',
      email: 'guest@outside.example',
      name: 'Guest',
      image: null,
      workspaceId: 'ws2',
      hd: 'outside.example',
      locale: 'en',
    })
    context.set(ctxContext, { waitUntil: vi.fn() })

    const result = await loader({
      params: { id: 'html123abc' },
      request: new Request('https://artifactshare.com/a/html123abc'),
      context,
    } as never)

    expect(result.kind).toBe('ok')
    if (result.kind !== 'ok') return
    expect(countShareableViewersMock).toHaveBeenCalledWith(expect.anything(), {
      shareableId: 'html123abc',
      requesterUserId: 'u9',
    })
    expect(result.artifact).toMatchObject({
      showViewerListMetaEntry: false,
      viewerListCount: 0,
    })
  })

  test('degrades viewer-list fields to false/0 when the count query fails', async () => {
    const { context } = setupHtmlShareable()
    recordViewAndNotifyViewCountMock.mockResolvedValue(undefined)
    countShareableViewersMock.mockRejectedValue(new Error('D1 unavailable'))
    const consoleError = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined)

    const result = await loader({
      params: { id: 'html123abc' },
      request: new Request('https://artifactshare.com/a/html123abc'),
      context,
    } as never)

    expect(result.kind).toBe('ok')
    if (result.kind !== 'ok') return
    expect(result.artifact).toMatchObject({
      showViewerListMetaEntry: false,
      viewerListCount: 0,
    })
    consoleError.mockRestore()
  })

  test('does not query or expose the viewer list for unsupported artifacts', async () => {
    const shareable = {
      id: 'site123abc',
      workspace_id: 'ws1',
      owner_user_id: 'u1',
      name: 'data.bin',
      derived_title: null,
      title_override: null,
      description: null,
      visibility: 'private',
      current_version_id: 'v1',
      current_published_at: '2026-05-24T00:00:00.000Z',
      owner_email: 'owner@example.com',
      owner_name: 'Owner',
      owner_image: null,
      r2_key: 'artifacts/site123abc/v1/data.bin',
      entrypoint_path: '/data.bin',
      version_artifact_kind: 'file',
      artifact_kind: 'file',
    }
    dbMock.selectFrom.mockImplementation((table: string) => {
      if (table === 'shareables') return shareableQuery(shareable)
      if (table === 'versions') return versionsQuery()
      if (table === 'workspaces') return emptyFirstQuery()
      if (table === 'workspace_members') return emptyFirstQuery()
      if (table === 'comment_threads') return emptyRowsQuery()
      if (table === 'comment_messages') return emptyFirstQuery()
      if (table === 'shareable_viewer_recency') return emptyFirstQuery()
      throw new Error(`unexpected table ${table}`)
    })
    viewerDisplayCheckMock.mockResolvedValue({
      kind: 'access-granted',
      meta: {
        modifiedTime: '2026-05-24T00:00:00Z',
        name: 'data.bin',
        mimeType: 'application/octet-stream',
        ownerEmail: 'owner@example.com',
      },
    })
    listGrantsMock.mockResolvedValue({ kind: 'ok', grants: [] })
    const context = new Map()
    context.set(userContext, {
      id: 'u1',
      email: 'owner@example.com',
      name: 'Owner',
      image: null,
      workspaceId: 'ws1',
      hd: 'example.com',
      locale: 'en',
    })
    context.set(ctxContext, { waitUntil: vi.fn() })

    const result = await loader({
      params: { id: 'site123abc' },
      request: new Request('https://artifactshare.com/a/site123abc'),
      context,
    } as never)

    expect(result.kind).toBe('unsupported')
    expect(countShareableViewersMock).not.toHaveBeenCalled()
  })

  test('returns static_site loader data with a signed sandbox URL', async () => {
    const shareable = {
      id: 'abc123def4',
      workspace_id: 'ws1',
      owner_user_id: 'u1',
      name: 'index.md',
      derived_title: null,
      title_override: null,
      description: null,
      visibility: 'private',
      current_version_id: 'v1',
      owner_email: 'owner@example.com',
      owner_name: 'Owner',
      owner_image: null,
      r2_key: 'ws1/abc123def4/v1/index.md',
      entrypoint_path: '/index.md',
      fallback_to_index: 0,
      version_artifact_kind: 'static_site',
    }
    dbMock.selectFrom.mockImplementation((table: string) => {
      if (table === 'shareables') return shareableQuery(shareable)
      if (table === 'versions') return versionsQuery()
      if (table === 'version_files') return versionFilesQuery()
      if (table === 'workspaces') return emptyFirstQuery()
      if (table === 'workspace_members') return emptyFirstQuery()
      if (table === 'comment_threads') return emptyRowsQuery()
      if (table === 'comment_messages') return emptyFirstQuery()
      if (table === 'shareable_viewer_recency') return emptyFirstQuery()
      throw new Error(`unexpected table ${table}`)
    })
    dbMock.updateTable.mockReturnValue(updateQuery())
    viewerDisplayCheckMock.mockResolvedValue({
      kind: 'ok',
      meta: {
        modifiedTime: '2026-05-24T00:00:00Z',
        name: 'index.md',
        mimeType: 'text/html',
        ownerEmail: 'owner@example.com',
      },
    })
    listGrantsMock.mockResolvedValue({ kind: 'ok', grants: [] })
    recordViewAndNotifyViewCountMock.mockResolvedValue(undefined)

    const waitUntil = vi.fn()
    const context = new Map()
    context.set(userContext, {
      id: 'u1',
      email: 'owner@example.com',
      name: 'Owner',
      image: null,
      workspaceId: 'ws1',
      hd: 'example.com',
      locale: 'en',
    })
    context.set(ctxContext, { waitUntil })

    const result = await loader({
      params: { id: 'abc123def4' },
      request: new Request('https://artifactshare.com/a/abc123def4'),
      context,
    } as never)

    expect(result.kind).toBe('static_site')
    if (result.kind !== 'static_site') return
    expect(result.artifact.canReplaceFile).toBe(true)
    expect(result.sandboxUrl).toMatch(
      /^https:\/\/abc123def4--v-7631\.sandbox\.artifactshare\.com\/index\.md\?t=/,
    )
    expect(result.bundlePaths).toEqual(['/index.md', '/other.md'])
    expect(result.fallbackToIndex).toBe(false)
    const token = new URL(result.sandboxUrl).searchParams.get('t')
    expect(token).toBeTruthy()
    const payload = await verifySandboxToken(
      token!,
      'test-secret-with-enough-entropy-for-hmac',
    )
    expect(payload).toMatchObject({
      uid: 'u1',
      wid: 'ws1',
      aid: 'abc123def4',
      vid: 'v1',
      fid: 'ws1/abc123def4/v1/index.md',
      t: 'static_site',
    })
    expect(waitUntil).toHaveBeenCalledTimes(1)
    expect(recordViewAndNotifyViewCountMock).toHaveBeenCalledTimes(1)

    const viewerContext = new Map()
    viewerContext.set(userContext, {
      id: 'u2',
      email: 'viewer@example.com',
      name: 'Viewer',
      image: null,
      workspaceId: 'ws1',
      hd: 'example.com',
      locale: 'en',
    })
    viewerContext.set(ctxContext, { waitUntil: vi.fn() })

    const viewerResult = await loader({
      params: { id: 'abc123def4' },
      request: new Request('https://artifactshare.com/a/abc123def4'),
      context: viewerContext,
    } as never)

    expect(viewerResult.kind).toBe('static_site')
    if (viewerResult.kind !== 'static_site') return
    expect(viewerResult.artifact.canReplaceFile).toBe(false)
  })

  test('uses root sandbox URL for static_site index.html entrypoints', async () => {
    const shareable = {
      id: 'site123abc',
      workspace_id: 'ws1',
      owner_user_id: 'u1',
      name: 'index.html',
      derived_title: null,
      title_override: null,
      description: null,
      visibility: 'private',
      current_version_id: 'v1',
      owner_email: 'owner@example.com',
      owner_name: 'Owner',
      owner_image: null,
      r2_key: 'ws1/site123abc/v1/index.html',
      entrypoint_path: '/index.html',
      fallback_to_index: 1,
      version_artifact_kind: 'static_site',
    }
    dbMock.selectFrom.mockImplementation((table: string) => {
      if (table === 'shareables') return shareableQuery(shareable)
      if (table === 'versions') return versionsQuery()
      if (table === 'version_files') return versionFilesQuery()
      if (table === 'workspaces') return emptyFirstQuery()
      if (table === 'workspace_members') return emptyFirstQuery()
      if (table === 'comment_threads') return emptyRowsQuery()
      if (table === 'comment_messages') return emptyFirstQuery()
      if (table === 'shareable_viewer_recency') return emptyFirstQuery()
      throw new Error(`unexpected table ${table}`)
    })
    dbMock.updateTable.mockReturnValue(updateQuery())
    viewerDisplayCheckMock.mockResolvedValue({
      kind: 'ok',
      meta: {
        modifiedTime: '2026-05-24T00:00:00Z',
        name: 'index.html',
        mimeType: 'text/html',
        ownerEmail: 'owner@example.com',
      },
    })
    listGrantsMock.mockResolvedValue({ kind: 'ok', grants: [] })
    recordViewAndNotifyViewCountMock.mockResolvedValue(undefined)

    const context = new Map()
    context.set(userContext, {
      id: 'u1',
      email: 'owner@example.com',
      name: 'Owner',
      image: null,
      workspaceId: 'ws1',
      hd: 'example.com',
      locale: 'en',
    })
    context.set(ctxContext, { waitUntil: vi.fn() })

    const result = await loader({
      params: { id: 'site123abc' },
      request: new Request('https://artifactshare.com/a/site123abc'),
      context,
    } as never)

    expect(result.kind).toBe('static_site')
    if (result.kind !== 'static_site') return
    expect(result.sandboxUrl).toMatch(
      /^https:\/\/site123abc--v-7631\.sandbox\.artifactshare\.com\/\?t=/,
    )
    expect(result.bundlePaths).toEqual(['/index.md', '/other.md'])
    expect(result.fallbackToIndex).toBe(true)
    const token = new URL(result.sandboxUrl).searchParams.get('t')
    expect(token).toBeTruthy()
    const payload = await verifySandboxToken(
      token!,
      'test-secret-with-enough-entropy-for-hmac',
    )
    expect(payload).toMatchObject({
      uid: 'u1',
      wid: 'ws1',
      aid: 'site123abc',
      vid: 'v1',
      fid: 'ws1/site123abc/v1/index.html',
      t: 'static_site',
    })
  })

  test('returns single-file html loader data on the version-scoped sandbox origin', async () => {
    const { context, waitUntil } = setupHtmlShareable()
    recordViewAndNotifyViewCountMock.mockResolvedValue(undefined)

    const result = await loader({
      params: { id: 'html123abc' },
      request: new Request('https://artifactshare.com/a/html123abc'),
      context,
    } as never)

    expect(result.kind).toBe('ok')
    if (result.kind !== 'ok') return
    expect(result.sandboxUrl).toMatch(
      /^https:\/\/html123abc--v-7631\.sandbox\.artifactshare\.com\/demo\.html\?t=/,
    )
    const token = new URL(result.sandboxUrl).searchParams.get('t')
    expect(token).toBeTruthy()
    const payload = await verifySandboxToken(
      token!,
      'test-secret-with-enough-entropy-for-hmac',
    )
    expect(payload).toMatchObject({
      uid: 'u1',
      wid: 'ws1',
      aid: 'html123abc',
      vid: 'v1',
      fid: 'artifacts/html123abc/v1/index.html',
      t: 'html',
    })
    expect(waitUntil).toHaveBeenCalledTimes(1)
  })

  test('does not record a view for prefetch requests', async () => {
    const { context, waitUntil } = setupHtmlShareable()

    const result = await loader({
      params: { id: 'html123abc' },
      request: new Request('https://artifactshare.com/a/html123abc.data', {
        headers: { 'Sec-Purpose': 'prefetch' },
      }),
      context,
    } as never)

    expect(result.kind).toBe('ok')
    expect(waitUntil).not.toHaveBeenCalled()
    expect(recordViewAndNotifyViewCountMock).not.toHaveBeenCalled()
    expect(dbMock.updateTable).not.toHaveBeenCalled()
  })

  test('records a view for non-prefetch data requests', async () => {
    const { context, waitUntil } = setupHtmlShareable()
    recordViewAndNotifyViewCountMock.mockResolvedValue(undefined)

    const result = await loader({
      params: { id: 'html123abc' },
      request: new Request('https://artifactshare.com/a/html123abc.data'),
      context,
    } as never)

    expect(result.kind).toBe('ok')
    expect(waitUntil).toHaveBeenCalledTimes(1)
    expect(recordViewAndNotifyViewCountMock).toHaveBeenCalledTimes(1)
    expect(recordViewAndNotifyViewCountMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      'html123abc',
      { kind: 'user', id: 'u1' },
      expect.objectContaining({
        versionSeenThroughAt: '2026-05-24T00:00:00.000Z',
      }),
      expect.anything(),
    )
  })

  test('waits only for recency persistence and keeps view work in waitUntil', async () => {
    const { context, waitUntil } = setupHtmlShareable()
    let finishRecency: (() => void) | undefined
    let finishView:
      | ((value: { counted: boolean; deferred: Promise<void> }) => void)
      | undefined
    const deferred = Promise.resolve()
    recordViewerRecencyMock.mockReturnValue(
      new Promise<void>((resolve) => {
        finishRecency = resolve
      }),
    )
    recordViewAndNotifyViewCountMock.mockReturnValue(
      new Promise((resolve) => {
        finishView = resolve
      }),
    )
    let loaderSettled = false
    const loading = loader({
      params: { id: 'html123abc' },
      request: new Request('https://artifactshare.com/a/html123abc.data'),
      context,
    } as never).then((result) => {
      loaderSettled = true
      return result
    })

    await vi.waitFor(() => expect(finishRecency).toBeDefined())
    expect(loaderSettled).toBe(false)
    expect(waitUntil).not.toHaveBeenCalled()
    finishRecency?.()
    await expect(loading).resolves.toMatchObject({ kind: 'ok' })
    expect(loaderSettled).toBe(true)
    expect(waitUntil).toHaveBeenCalledOnce()
    expect(waitUntil.mock.calls[0]?.[0]).toBeInstanceOf(Promise)
    await vi.waitFor(() => expect(finishView).toBeDefined())
    finishView?.({ counted: true, deferred })
    await expect(waitUntil.mock.calls[0]?.[0]).resolves.toEqual([undefined])
  })

  test('keeps the file available when recency persistence fails', async () => {
    const { context, waitUntil } = setupHtmlShareable()
    const consoleError = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined)
    recordViewerRecencyMock.mockRejectedValue(
      new Error('recency persistence failed'),
    )
    recordViewAndNotifyViewCountMock.mockResolvedValue(undefined)

    await expect(
      loader({
        params: { id: 'html123abc' },
        request: new Request('https://artifactshare.com/a/html123abc.data'),
        context,
      } as never),
    ).resolves.toMatchObject({ kind: 'ok' })
    expect(waitUntil).toHaveBeenCalledOnce()
    await expect(waitUntil.mock.calls[0]?.[0]).resolves.toEqual([undefined])
    expect(consoleError).toHaveBeenCalledWith(
      'view_recency_write_failed',
      expect.objectContaining({ shareable_id: 'html123abc' }),
    )
    consoleError.mockRestore()
  })

  test('does not leave a rejected follow-up when deferred view work fails', async () => {
    const { context, waitUntil } = setupHtmlShareable()
    let rejectDeferred: ((reason: Error) => void) | undefined
    const deferred = new Promise<void>((_resolve, reject) => {
      rejectDeferred = reject
    })
    recordViewAndNotifyViewCountMock.mockResolvedValue({
      counted: true,
      deferred,
    })

    const loading = loader({
      params: { id: 'html123abc' },
      request: new Request('https://artifactshare.com/a/html123abc.data'),
      context,
    } as never)
    await expect(loading).resolves.toMatchObject({ kind: 'ok' })
    rejectDeferred?.(new Error('deferred view work failed'))
    await expect(waitUntil.mock.calls[0]?.[0]).resolves.toEqual([undefined])
  })

  test('keeps the explicit current version available to anonymous link viewers', async () => {
    const shareable = {
      id: 'link123abc',
      workspace_id: 'ws1',
      owner_user_id: 'u1',
      name: 'demo.html',
      derived_title: null,
      title_override: null,
      description: null,
      visibility: 'link',
      view_count: 4,
      current_version_id: 'v1',
      owner_email: 'owner@example.com',
      owner_name: 'Owner',
      owner_image: null,
      r2_key: 'artifacts/link123abc/v1/index.html',
      entrypoint_path: '/demo.html',
      fallback_to_index: 0,
      version_artifact_kind: 'html_page',
      artifact_kind: 'html_page',
      container_id: null,
      return_project_kind: null,
      return_project_base_visibility: null,
      return_project_id: null,
      return_project_name: null,
      artifact_workspace_hd: null,
      container_creator_email: null,
    }
    dbMock.selectFrom.mockImplementation((table: string) => {
      if (table === 'shareables') return shareableQuery(shareable)
      throw new Error(`unexpected table ${table}`)
    })
    viewerDisplayCheckMock.mockResolvedValue({
      kind: 'access-granted',
      meta: {
        modifiedTime: '2026-05-24T00:00:00Z',
        name: 'demo.html',
        mimeType: 'text/html',
        ownerEmail: 'owner@example.com',
      },
    })
    recordViewAndNotifyViewCountMock.mockResolvedValue({ counted: true })

    const waitUntil = vi.fn()
    const context = new Map()
    context.set(userContext, null)
    context.set(ctxContext, { waitUntil })

    const result = await loader({
      params: { id: 'link123abc' },
      request: new Request('https://artifactshare.com/a/link123abc?version=v1'),
      context,
    } as never)

    expect(result.kind).toBe('ok')
    expect(waitUntil).toHaveBeenCalledTimes(1)
    expect(recordViewAndNotifyViewCountMock).toHaveBeenCalledWith(
      dbMock,
      {},
      'link123abc',
      { kind: 'anon', id: 'anon-1', fallbackId: 'fallback-1' },
      { hmacSecret: 'test-secret-with-enough-entropy-for-hmac' },
      commentLiveMock,
    )
  })

  test('preauth meta explains unauthenticated access without artifact metadata', () => {
    const tags = meta({
      loaderData: {
        kind: 'preauth',
        canonicalUrl: 'https://artifactshare.com/a/html123abc',
        artifact: {
          id: 'html123abc',
          name: 'demo.html',
          derivedTitle: 'Demo Report',
          titleOverride: null,
          description: 'A shared report',
        },
      },
    } as never)
    const description =
      'This Artifact Share file requires sign-in with an allowed account. AI assistants cannot read the file contents from this unauthenticated page. Shell-capable agents can try npx --yes @artifactshare/cli open https://artifactshare.com/a/html123abc.'

    expect(tags).toContainEqual({
      property: 'og:title',
      content: 'Artifact Share',
    })
    expect(tags).toContainEqual({ name: 'description', content: description })
    expect(tags).toContainEqual({
      property: 'og:description',
      content: 'Shared via Artifact Share',
    })
    expect(JSON.stringify(tags)).not.toContain('Demo Report')
    expect(JSON.stringify(tags)).not.toContain('demo.html')
    expect(JSON.stringify(tags)).not.toContain('A shared report')
    expect(tags).not.toContainEqual(
      expect.objectContaining({ property: 'og:image' }),
    )
  })

  test('renders preauth agent guidance with the CLI open command', () => {
    const command = buildPreauthCliOpenCommand(
      'https://artifactshare.com/a/html123abc',
    )
    const html = renderToStaticMarkup(
      <TooltipProvider>
        <AgentHelpContent cliCommand={command} interactive />
      </TooltipProvider>,
    )

    expect(html).toContain(
      'If you are reading this page without signing in, you cannot read the file contents.',
    )
    expect(html).toContain('If you can run shell commands')
    expect(html).toContain('Shell command')
    expect(html).toContain(command)
    expect(html).toContain('Copy command')
    expect(html).toContain('If you cannot run commands')
  })

  test('builds a preauth CLI open command for the current share URL', () => {
    expect(
      buildPreauthCliOpenCommand('https://artifactshare.com/a/html123abc'),
    ).toBe(
      'npx --yes @artifactshare/cli open https://artifactshare.com/a/html123abc',
    )
  })

  test('does not emit Open Graph image tags for static site shares', () => {
    const tags = meta({
      loaderData: {
        kind: 'static_site',
        canonicalUrl: 'https://artifactshare.com/a/site123abc',
        sandboxUrl: 'https://site123abc.sandbox.artifactshare.com/index.html',
        fallbackToIndex: true,
        user: null,
        artifact: {
          id: 'site123abc',
          storageKey: 'artifacts/site123abc/v1/index.html',
          name: 'index.html',
          derivedTitle: 'Static Site',
          titleOverride: null,
          ownerId: 'u1',
          ownerEmail: 'owner@example.com',
          ownerName: 'Owner',
          ownerImage: null,
          ownerInitial: 'O',
          modifiedTime: null,
          visibility: 'private',
          canViewHistory: true,
          versions: [],
          description: null,
          currentVersionId: 'v1',
        },
      },
    } as never)

    expect(tags).not.toContainEqual(
      expect.objectContaining({ property: 'og:image' }),
    )
  })

  test('does not emit Open Graph image tags for non-link single-file shares', () => {
    const tags = meta({
      loaderData: {
        kind: 'ok',
        canonicalUrl: 'https://artifactshare.com/a/html123abc',
        sandboxUrl: 'https://html123abc.sandbox.artifactshare.com/demo.html',
        renderType: 'html',
        user: null,
        artifact: {
          id: 'html123abc',
          storageKey: 'artifacts/html123abc/v1/index.html',
          name: 'demo.html',
          derivedTitle: 'Demo Report',
          titleOverride: null,
          description: 'A private report',
          ownerId: 'u1',
          ownerEmail: 'owner@example.com',
          ownerName: 'Owner',
          ownerImage: null,
          ownerInitial: 'O',
          ownerIsExternal: false,
          modifiedTime: null,
          visibility: 'private',
          ogImageKey: '2026-06-29T00:00:00Z',
          canReplaceFile: false,
          canViewHistory: false,
          canChangeVisibility: false,
          canMove: false,
          versions: [],
          currentVersionId: 'v1',
          grants: [],
          comments: [],
          defaultReturnTo: '/',
          viewCount: 0,
          workspaceHd: null,
          workspaceMsTenantId: null,
          availableVisibilities: [],
          projectId: null,
          projectName: null,
        },
      },
    } as never)

    expect(tags).not.toContainEqual(
      expect.objectContaining({ property: 'og:image' }),
    )
    expect(tags).not.toContainEqual(
      expect.objectContaining({ property: 'og:title' }),
    )
  })

  test('emits a large Open Graph card for link shares', () => {
    const tags = meta({
      loaderData: {
        kind: 'ok',
        canonicalUrl: 'https://artifactshare.com/a/link123abc',
        sandboxUrl: 'https://link123abc.sandbox.artifactshare.com/demo.html',
        renderType: 'html',
        user: null,
        artifact: {
          id: 'link123abc',
          storageKey: 'artifacts/link123abc/v1/index.html',
          name: 'demo.html',
          derivedTitle: 'Demo Report',
          titleOverride: null,
          description: 'A shared report',
          ownerId: 'u1',
          ownerEmail: 'owner@example.com',
          ownerName: 'Owner',
          ownerImage: null,
          ownerInitial: 'O',
          ownerIsExternal: false,
          modifiedTime: null,
          visibility: 'link',
          ogImageKey: '2026-06-29T00:00:00Z',
          canReplaceFile: false,
          canViewHistory: false,
          canChangeVisibility: false,
          canMove: false,
          versions: [],
          currentVersionId: 'v1',
          grants: [],
          comments: [],
          defaultReturnTo: '/',
          viewCount: 0,
          workspaceHd: null,
          workspaceMsTenantId: null,
          availableVisibilities: [],
          projectId: null,
          projectName: null,
        },
      },
    } as never)

    expect(tags).toContainEqual({
      property: 'og:image',
      content:
        'https://artifactshare.com/a/link123abc/og-image?v=2026-06-29T00%3A00%3A00Z',
    })
    expect(tags).toContainEqual({
      name: 'twitter:card',
      content: 'summary_large_image',
    })
    expect(tags).toContainEqual({
      property: 'og:description',
      content: 'A shared report',
    })
  })
})

function shareableQuery(row: unknown) {
  return chain({
    executeTakeFirst: vi.fn().mockResolvedValue(row),
  })
}

function versionsQuery() {
  return chain({
    executeTakeFirst: vi.fn().mockResolvedValue({ count: 1 }),
    execute: vi.fn().mockResolvedValue([
      {
        id: 'v1',
        createdAt: '2026-05-24T00:00:00Z',
        sizeBytes: 128,
      },
    ]),
  })
}

function emptyFirstQuery() {
  return chain({
    executeTakeFirst: vi.fn().mockResolvedValue(undefined),
  })
}

function emptyRowsQuery() {
  return chain({
    execute: vi.fn().mockResolvedValue([]),
  })
}

function versionFilesQuery() {
  return chain({
    execute: vi
      .fn()
      .mockResolvedValue([{ path: '/index.md' }, { path: '/other.md' }]),
  })
}

function setupHtmlShareable() {
  const shareable = {
    id: 'html123abc',
    workspace_id: 'ws1',
    owner_user_id: 'u1',
    name: 'demo.html',
    derived_title: null,
    title_override: null,
    description: null,
    visibility: 'private',
    current_version_id: 'v1',
    current_published_at: '2026-05-24T00:00:00.000Z',
    owner_email: 'owner@example.com',
    owner_name: 'Owner',
    owner_image: null,
    r2_key: 'artifacts/html123abc/v1/index.html',
    entrypoint_path: '/demo.html',
    version_artifact_kind: 'html_page',
  }
  dbMock.selectFrom.mockImplementation((table: string) => {
    if (table === 'shareables') return shareableQuery(shareable)
    if (table === 'versions') return versionsQuery()
    if (table === 'workspaces') return emptyFirstQuery()
    if (table === 'workspace_members') return emptyFirstQuery()
    if (table === 'comment_threads') return emptyRowsQuery()
    if (table === 'comment_messages') return emptyFirstQuery()
    if (table === 'shareable_viewer_recency') return emptyFirstQuery()
    throw new Error(`unexpected table ${table}`)
  })
  dbMock.updateTable.mockReturnValue(updateQuery())
  viewerDisplayCheckMock.mockResolvedValue({
    kind: 'ok',
    meta: {
      modifiedTime: '2026-05-24T00:00:00Z',
      name: 'demo.html',
      mimeType: 'text/html',
      ownerEmail: 'owner@example.com',
    },
  })
  listGrantsMock.mockResolvedValue({ kind: 'ok', grants: [] })

  const waitUntil = vi.fn()
  const context = new Map()
  context.set(userContext, {
    id: 'u1',
    email: 'owner@example.com',
    name: 'Owner',
    image: null,
    workspaceId: 'ws1',
    hd: 'example.com',
    locale: 'en',
  })
  context.set(ctxContext, { waitUntil })
  return { context, waitUntil }
}

function updateQuery() {
  return chain({
    execute: vi.fn().mockResolvedValue(undefined),
  })
}

function chain<T extends Record<string, unknown>>(terminal: T): T {
  const target: Record<string, unknown> = { ...terminal }
  for (const method of [
    'innerJoin',
    'leftJoin',
    'select',
    'where',
    'orderBy',
    'limit',
    'set',
  ]) {
    target[method] = vi.fn(() => target)
  }
  return target as T
}
