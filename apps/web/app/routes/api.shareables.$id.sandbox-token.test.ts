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
const checkAnonymousLinkAccessMock = vi.hoisted(() => vi.fn())
const accessFactsMock = vi.hoisted(() => vi.fn())
const viewerAccessAllowedMock = vi.hoisted(() => vi.fn())

vi.mock('~/middleware/auth', () => ({
  requireUserApiMiddleware: requireUserApiMiddlewareMock,
}))
const userContextSymbol = vi.hoisted(() => Symbol('userContext'))
const linkDomainContextSymbol = vi.hoisted(() => Symbol('linkDomainContext'))
vi.mock('~/middleware/context', () => ({
  requireUser: requireUserMock,
  userContext: userContextSymbol,
  linkDomainContext: linkDomainContextSymbol,
}))
vi.mock('~/services/db.server', () => ({
  createDb: () => dbMock,
}))
vi.mock('~/services/access.server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('~/services/access.server')>()),
  viewerAccessAllowed: viewerAccessAllowedMock,
}))
vi.mock('~/modules/access/facts', () => ({ facts: accessFactsMock }))
vi.mock('~/services/link-sharing.server', () => ({
  checkAnonymousLinkAccess: checkAnonymousLinkAccessMock,
}))

import { loader } from './api.shareables.$id.sandbox-token'

describe('/api/shareables/:id/sandbox-token', () => {
  beforeEach(() => {
    requireUserApiMiddlewareMock.mockReset()
    requireUserMock.mockReset()
    dbMock.selectFrom.mockReset()
    checkAnonymousLinkAccessMock.mockReset()
    accessFactsMock.mockReset()
    viewerAccessAllowedMock.mockReset()
    accessFactsMock.mockResolvedValue({
      viewerUserId: 'u1',
      artifactWorkspaceId: 'ws1',
    })
    viewerAccessAllowedMock.mockReturnValue(true)
    checkAnonymousLinkAccessMock.mockResolvedValue({ kind: 'allowed' })
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
    ['html_page', 'html', 'demo.html', '/demo.html'],
    ['markdown_page', 'md', 'notes.md', '/notes.md'],
  ])(
    'returns a fresh sandbox URL for a named %s entrypoint',
    async (artifactKind, renderType, name, entrypointPath) => {
      dbMock.selectFrom.mockReturnValue(
        shareableQuery({
          id: 'html123abc',
          workspace_id: 'ws1',
          owner_user_id: 'owner1',
          name,
          visibility: 'private',
          container_id: null,
          current_version_id: 'v1',
          project_container_kind: null,
          project_container_base_visibility: null,
          r2_key: `ws1/html123abc/v1/${name}`,
          entrypoint_path: entrypointPath,
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
      expect(new URL(body.sandboxUrl).pathname).toBe(entrypointPath)
      expect(body.sandboxUrl).not.toContain('as_next=')
    },
  )

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
    expect(new URL(body.sandboxUrl).pathname).toBe('/demo.html')
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
    viewerAccessAllowedMock.mockReturnValue(false)

    const response = await loader(loaderArgs('abc123def4'))

    expect(response.status).toBe(404)
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
  })

  test('forces anonymous current-version tokens on the link domain', async () => {
    dbMock.selectFrom.mockReturnValue(
      shareableQuery({
        id: 'abc123def4',
        workspace_id: 'ws1',
        owner_user_id: 'owner1',
        name: 'index.html',
        visibility: 'link',
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

    const response = await loader(loaderArgs('abc123def4', 'old', true))
    const body = (await response.json()) as { sandboxUrl: string }
    expect(body.sandboxUrl).toMatch(
      /^https:\/\/abc123def4--v-7631\.artifactshare\.link\/\?t=/,
    )
    const token = new URL(body.sandboxUrl).searchParams.get('t')
    await expect(
      verifySandboxToken(token!, 'test-secret-with-enough-entropy-for-hmac'),
    ).resolves.toMatchObject({ uid: null, vid: 'v1' })
    expect(checkAnonymousLinkAccessMock).toHaveBeenCalledWith(
      expect.anything(),
      'abc123def4',
    )
  })

  test('uses checkAnonymousLinkAccess expiry semantics for anonymous token issuance', async () => {
    requireUserMock.mockReturnValue(null)
    checkAnonymousLinkAccessMock.mockResolvedValue({ kind: 'expired' })
    dbMock.selectFrom.mockReturnValue(
      shareableQuery({
        id: 'abc123def4',
        workspace_id: 'ws1',
        owner_user_id: 'owner1',
        name: 'index.html',
        visibility: 'link',
        container_id: null,
        current_version_id: 'v1',
        r2_key: 'ws1/abc123def4/v1/index.html',
        entrypoint_path: '/index.html',
        artifact_kind: 'static_site',
        version_artifact_kind: 'static_site',
      }),
    )

    const response = await loader(loaderArgs('abc123def4'))

    expect(response.status).toBe(404)
    expect(checkAnonymousLinkAccessMock).toHaveBeenCalledWith(
      expect.anything(),
      'abc123def4',
    )
  })
})

function loaderArgs(id = 'abc123def4', versionId?: string, linkDomain = false) {
  const ctx = new Map()
  const user = requireUserMock()
  if (user) ctx.set(userContextSymbol, user)
  if (linkDomain) ctx.set(linkDomainContextSymbol, { shareableId: id })
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
