import { beforeEach, describe, expect, test, vi } from 'vitest'
import { verifySandboxToken } from '~/lib/sandbox-token'

vi.mock('cloudflare:workers', () => ({
  env: {
    APP_ENV: 'production',
    BETTER_AUTH_SECRET: 'test-secret-with-enough-entropy-for-hmac',
  },
}))

const requireUserApiMiddlewareMock = vi.hoisted(() => vi.fn())
const requireUserMock = vi.hoisted(() => vi.fn())
const dbMock = vi.hoisted(() => ({
  selectFrom: vi.fn(),
}))
const viewerDisplayCheckMock = vi.hoisted(() => vi.fn())

vi.mock('~/middleware/auth', () => ({
  requireUserApiMiddleware: requireUserApiMiddlewareMock,
}))
const userContextSymbol = vi.hoisted(() => Symbol('userContext'))
vi.mock('~/middleware/context', () => ({
  requireUser: requireUserMock,
  userContext: userContextSymbol,
}))
vi.mock('~/services/db.server', () => ({
  createDb: () => dbMock,
}))
vi.mock('~/services/access.server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('~/services/access.server')>()),
  viewerDisplayCheck: viewerDisplayCheckMock,
}))

import { loader } from './api.shareables.$id.sandbox-token'

describe('/api/shareables/:id/sandbox-token', () => {
  beforeEach(() => {
    requireUserApiMiddlewareMock.mockReset()
    requireUserMock.mockReset()
    dbMock.selectFrom.mockReset()
    viewerDisplayCheckMock.mockReset()
    viewerDisplayCheckMock.mockResolvedValue({
      kind: 'access-granted',
      meta: {
        modifiedTime: null,
        name: 'file',
        mimeType: 'text/html',
        ownerEmail: null,
      },
    })
    requireUserMock.mockReturnValue({
      id: 'u1',
      email: 'viewer@example.com',
      workspaceId: 'ws1',
      hd: 'example.com',
    })
  })

  test('unauthenticated requests for non-link visibility return 401', async () => {
    requireUserMock.mockReturnValue(null)
    dbMock.selectFrom.mockReturnValue(
      shareableQuery({
        id: 's1',
        visibility: 'private',
        r2_key: 'key1',
        current_version_id: 'v1',
        artifact_kind: 'static_site',
        version_artifact_kind: 'static_site',
      }),
    )

    const response = await loader(loaderArgs())

    expect((response as Response).status).toBe(401)
  })

  test('returns a fresh static-site sandbox URL for an allowed viewer', async () => {
    dbMock.selectFrom.mockReturnValue(
      shareableQuery({
        id: 'abc123def4',
        workspace_id: 'ws1',
        owner_user_id: 'owner1',
        name: 'index.html',
        visibility: 'private',
        container_id: null,
        current_version_id: 'v1',
        project_container_kind: null,
        project_container_base_visibility: null,
        r2_key: 'ws1/abc123def4/v1/index.html',
        entrypoint_path: '/index.html',
        artifact_kind: 'static_site',
        version_artifact_kind: 'static_site',
      }),
    )
    viewerDisplayCheckMock.mockResolvedValue({
      kind: 'access-granted',
      meta: {
        modifiedTime: '2026-06-04T00:00:00Z',
        name: 'index.html',
        mimeType: 'text/html',
        ownerEmail: 'owner@example.com',
      },
    })

    const response = await loader(loaderArgs('abc123def4'))

    expect(response.status).toBe(200)
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
    const body = (await response.json()) as { sandboxUrl: string }
    expect(body.sandboxUrl).toMatch(
      /^https:\/\/abc123def4--v-7631\.sandbox\.artifactshare\.com\/\?t=/,
    )
    const token = new URL(body.sandboxUrl).searchParams.get('t')
    expect(token).toBeTruthy()
    await expect(
      verifySandboxToken(token!, 'test-secret-with-enough-entropy-for-hmac'),
    ).resolves.toMatchObject({
      uid: 'u1',
      wid: 'ws1',
      aid: 'abc123def4',
      vid: 'v1',
      fid: 'ws1/abc123def4/v1/index.html',
      t: 'static_site',
    })
  })

  test.each([
    ['html_page', 'html'],
    ['markdown_page', 'md'],
  ])('returns a token for %s', async (artifactKind, renderType) => {
    dbMock.selectFrom.mockReturnValue(
      shareableQuery({
        id: 'html123abc',
        workspace_id: 'ws1',
        owner_user_id: 'owner1',
        name: 'demo.html',
        visibility: 'private',
        container_id: null,
        current_version_id: 'v1',
        project_container_kind: null,
        project_container_base_visibility: null,
        r2_key: 'ws1/html123abc/v1/demo.html',
        entrypoint_path: '/demo.html',
        artifact_kind: artifactKind,
        version_artifact_kind: artifactKind,
      }),
    )

    const response = await loader(loaderArgs('html123abc'))

    expect(response.status).toBe(200)
    const body = (await response.json()) as {
      sandboxUrl: string
      renderType: string
    }
    expect(body.renderType).toBe(renderType)
    expect(body.sandboxUrl).not.toContain('as_next=')
  })

  test('refreshes the selected published historical version', async () => {
    let queryCount = 0
    dbMock.selectFrom.mockImplementation(() => {
      queryCount += 1
      return shareableQuery(
        queryCount === 1
          ? {
              id: 'html123abc',
              workspace_id: 'ws1',
              owner_user_id: 'owner1',
              name: 'demo.html',
              visibility: 'private',
              container_id: null,
              current_version_id: 'v2',
              r2_key: 'ws1/html123abc/v2/demo.html',
              entrypoint_path: '/demo.html',
              artifact_kind: 'html_page',
              version_artifact_kind: 'html_page',
            }
          : {
              id: 'v1',
              r2_key: 'ws1/html123abc/v1/demo.html',
              entrypoint_path: '/demo.html',
              artifact_kind: 'html_page',
            },
      )
    })

    const response = await loader(loaderArgs('html123abc', 'v1'))

    expect(response.status).toBe(200)
    const body = (await response.json()) as { sandboxUrl: string }
    expect(body.sandboxUrl).toContain(
      'html123abc--v-7631.sandbox.artifactshare.com',
    )
    const token = new URL(body.sandboxUrl).searchParams.get('t')
    await expect(
      verifySandboxToken(token!, 'test-secret-with-enough-entropy-for-hmac'),
    ).resolves.toMatchObject({ vid: 'v1', fid: 'ws1/html123abc/v1/demo.html' })
  })

  test('does not return a token when access is denied', async () => {
    dbMock.selectFrom.mockReturnValue(
      shareableQuery({
        id: 'abc123def4',
        workspace_id: 'ws1',
        owner_user_id: 'owner1',
        name: 'index.html',
        visibility: 'private',
        container_id: null,
        current_version_id: 'v1',
        project_container_kind: null,
        project_container_base_visibility: null,
        r2_key: 'ws1/abc123def4/v1/index.html',
        entrypoint_path: '/index.html',
        artifact_kind: 'static_site',
        version_artifact_kind: 'static_site',
      }),
    )
    viewerDisplayCheckMock.mockResolvedValue({ kind: 'access-denied' })

    const response = await loader(loaderArgs('abc123def4'))

    expect(response.status).toBe(404)
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
  })
})

function loaderArgs(id = 'abc123def4', versionId?: string) {
  const ctx = new Map()
  const user = requireUserMock()
  if (user) ctx.set(userContextSymbol, user)
  return {
    context: ctx,
    params: { id },
    request: new Request(
      `https://artifactshare.test/api/shareables/${id}/sandbox-token${
        versionId ? `?version=${versionId}` : ''
      }`,
    ),
  } as never
}

function shareableQuery(row: unknown) {
  return chain({
    executeTakeFirst: vi.fn().mockResolvedValue(row),
  })
}

function chain<T extends Record<string, unknown>>(terminal: T): T {
  const target: Record<string, unknown> = { ...terminal }
  for (const method of ['leftJoin', 'select', 'where']) {
    target[method] = vi.fn(() => target)
  }
  return target as T
}
