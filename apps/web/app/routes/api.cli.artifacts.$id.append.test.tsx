import { beforeEach, describe, expect, test, vi } from 'vitest'

const requireUserApiWithBearerMiddlewareMock = vi.hoisted(() => vi.fn())
const requireUserMock = vi.hoisted(() => vi.fn())
const publishMock = vi.hoisted(() => vi.fn())
const publishPrincipalMock = vi.hoisted(() => vi.fn())
const ctxContextMock = vi.hoisted(() => ({}))

vi.mock('cloudflare:workers', () => ({
  env: { APP_ENV: 'development' },
}))

vi.mock('~/middleware/auth', () => ({
  requireUserApiWithBearerMiddleware: requireUserApiWithBearerMiddlewareMock,
}))
vi.mock('~/middleware/context', () => ({
  ctxContext: ctxContextMock,
  getCliAuthority: () => null,
  requireUser: requireUserMock,
}))
vi.mock('~/modules/publish', () => ({
  publish: publishMock,
  publishPrincipal: publishPrincipalMock,
}))

import { action, middleware } from './api.cli.artifacts.$id.append'

describe('/api/cli/artifacts/:id/append', () => {
  beforeEach(() => {
    requireUserApiWithBearerMiddlewareMock.mockReset()
    requireUserMock.mockReset()
    publishMock.mockReset().mockResolvedValue({
      kind: 'ok',
      versionId: 'v2',
      artifactKind: 'html_page',
      visibility: 'private',
    })
    publishPrincipalMock.mockReset().mockReturnValue({ kind: 'human' })
    requireUserMock.mockReturnValue({
      id: 'u1',
      kind: 'human',
      email: 'owner@example.com',
      workspaceId: 'ws1',
      hd: 'example.com',
    })
  })

  test('keeps bearer authentication middleware', () => {
    expect(middleware).toEqual([requireUserApiWithBearerMiddlewareMock])
  })

  test('action forwards an append intent to the publish boundary', async () => {
    const waitUntil = vi.fn()
    const response = await action({
      context: new Map([[ctxContextMock, { waitUntil }]]),
      params: { id: 'abc123def4' },
      request: new Request(
        'https://artifactshare.test/api/cli/artifacts/abc123def4/append',
        {
          method: 'POST',
          body: JSON.stringify({ content: '<p>added</p>' }),
        },
      ),
    } as never)

    expect(response.status).toBe(200)
    expect(publishPrincipalMock).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'u1' }),
      null,
    )
    expect(publishMock).toHaveBeenCalledWith({
      actor: { kind: 'human' },
      target: { kind: 'append', artifactId: 'abc123def4' },
      content: { kind: 'append', content: '<p>added</p>' },
      waitUntil: expect.any(Function),
    })
    const background = Promise.resolve()
    publishMock.mock.calls[0]?.[0].waitUntil(background)
    expect(waitUntil).toHaveBeenCalledWith(background)
    expect(await response.json()).toEqual({
      id: 'abc123def4',
      versionId: 'v2',
      shareUrl: 'https://artifactshare.test/a/abc123def4',
      artifactKind: 'html_page',
    })
  })

  test('rejects malformed append payloads through the shared contract', async () => {
    const response = await action({
      context: new Map([[ctxContextMock, { waitUntil: vi.fn() }]]),
      params: { id: 'abc123def4' },
      request: new Request(
        'https://artifactshare.test/api/cli/artifacts/abc123def4/append',
        {
          method: 'POST',
          body: JSON.stringify({ content: '' }),
        },
      ),
    } as never)

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toEqual({
      error: {
        code: 'validation_failed',
        message: 'Non-empty UTF-8 content is required.',
      },
    })
    expect(publishMock).not.toHaveBeenCalled()
  })

  test('returns the per-ID URL when appending to a link artifact', async () => {
    publishMock.mockResolvedValueOnce({
      kind: 'ok',
      versionId: 'v2',
      artifactKind: 'html_page',
      visibility: 'link',
    })
    const response = await action({
      context: new Map([[ctxContextMock, { waitUntil: vi.fn() }]]),
      params: { id: 'abc123def4' },
      request: new Request(
        'https://artifactshare.test/api/cli/artifacts/abc123def4/append',
        {
          method: 'POST',
          body: JSON.stringify({ content: '<p>added</p>' }),
        },
      ),
    } as never)

    expect(await response.json()).toMatchObject({
      shareUrl: 'https://abc123def4.localhost:5173/',
    })
  })

  test.each([
    [
      { kind: 'forbidden' },
      403,
      'forbidden',
      'CLI agent scope does not allow this update.',
    ],
    [
      { kind: 'self-upload-disabled' },
      403,
      'self-upload-disabled',
      'Sign in with Google or Microsoft to upload files.',
    ],
    [
      { kind: 'storage-failed' },
      502,
      'storage-failed',
      'Could not save the file. Try again.',
    ],
    [
      { kind: 'quota-exceeded' },
      413,
      'quota-exceeded',
      'Storage quota is exceeded.',
    ],
    [
      { kind: 'copy-forbidden' },
      403,
      'copy-forbidden',
      'Static sites are not supported; append only works for a single Markdown or HTML artifact. Use update to replace the full source.',
    ],
  ])(
    'maps publish failure %j to the existing CLI error contract',
    async (result, status, code, message) => {
      publishMock.mockResolvedValueOnce(result)
      const response = await action({
        context: new Map([[ctxContextMock, { waitUntil: vi.fn() }]]),
        params: { id: 'abc123def4' },
        request: new Request(
          'https://artifactshare.test/api/cli/artifacts/abc123def4/append',
          { method: 'POST', body: JSON.stringify({ content: 'added' }) },
        ),
      } as never)

      expect(response.status).toBe(status)
      await expect(response.json()).resolves.toEqual({
        error: { code, message },
      })
    },
  )

  test('preserves the append-specific version conflict details', async () => {
    publishMock.mockResolvedValueOnce({
      kind: 'version-conflict',
      currentVersionId: 'v-current',
    })
    const response = await action({
      context: new Map([[ctxContextMock, { waitUntil: vi.fn() }]]),
      params: { id: 'abc123def4' },
      request: new Request(
        'https://artifactshare.test/api/cli/artifacts/abc123def4/append',
        { method: 'POST', body: JSON.stringify({ content: 'added' }) },
      ),
    } as never)

    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toEqual({
      error: {
        code: 'version_conflict',
        message:
          'The artifact changed before append. Current version: v-current.',
        details: { current_version_id: 'v-current' },
      },
    })
  })
})
