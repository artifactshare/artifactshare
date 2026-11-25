const authorityMock = vi.hoisted(() => vi.fn())
import type { CliAuthority } from '~/services/cli-authority.server'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { expectApiError } from '~/test/api-error'

const requireUserApiWithBearerMiddlewareMock = vi.hoisted(() => vi.fn())
const requireUserMock = vi.hoisted(() => vi.fn())
const publishMock = vi.hoisted(() => vi.fn())
const publishPrincipalMock = vi.hoisted(() => vi.fn())
vi.mock('~/services/db.server', () => ({
  withDb: (callback: (db: unknown) => unknown) => callback({}),
}))
const ctxContextMock = vi.hoisted(() => ({}))

vi.mock('cloudflare:workers', () => ({
  env: { APP_ENV: 'development' },
}))

vi.mock('~/middleware/auth', () => ({
  requireUserApiWithBearerMiddleware: requireUserApiWithBearerMiddlewareMock,
}))
vi.mock('~/middleware/context', () => ({
  ctxContext: ctxContextMock,
  getCliAuthority: authorityMock,
  requireUser: requireUserMock,
}))
vi.mock('~/modules/publish', () => ({
  publish: publishMock,
  publishPrincipal: publishPrincipalMock,
}))

import { action, middleware } from './api.cli.artifacts.$id.append'

describe('/api/cli/artifacts/:id/append', () => {
  beforeEach(() => {
    authorityMock.mockReset().mockReturnValue(null)
    requireUserApiWithBearerMiddlewareMock.mockReset()
    requireUserMock.mockReset()
    publishMock.mockReset().mockImplementation(async (intent) => {
      const content = await intent.content.content()
      if (content === null) return { kind: 'invalid-append-content' }
      return {
        kind: 'ok',
        versionId: 'v2',
        artifactKind: 'html_page',
        visibility: 'private',
      }
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

  test('denies unknown authority before mutation', async () => {
    authorityMock.mockReturnValue({
      kind: 'unknown',
    } as unknown as CliAuthority)
    const request = new Request(
      'https://example.test/api/cli/artifacts/abc123def4',
      {
        method: 'POST',
        body: JSON.stringify({
          title: 'Changed',
          destination: 'home',
          content: '<p>added</p>',
        }),
      },
    )
    const response = await action({
      context: new Map(),
      params: { id: 'abc123def4' },
      request,
    } as never)
    expect(response.status).toBe(403)
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'scope-denied' },
    })
    expect(publishMock).not.toHaveBeenCalled()
    expect(request.bodyUsed).toBe(false)
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
      content: { kind: 'append', content: expect.any(Function) },
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

  test.each(['{', '', '{}', '{"content":""}'])(
    'rejects invalid append payload %j through the shared contract',
    async (body) => {
      const response = await action({
        context: new Map([[ctxContextMock, { waitUntil: vi.fn() }]]),
        params: { id: 'abc123def4' },
        request: new Request(
          'https://artifactshare.test/api/cli/artifacts/abc123def4/append',
          {
            method: 'POST',
            body,
          },
        ),
      } as never)

      await expectApiError(response, {
        status: 400,
        code: 'validation_failed',
      })
      expect(publishMock).toHaveBeenCalledTimes(1)
    },
  )

  describe.each(['not-found', 'self-upload-disabled'])(
    'denied append: %s',
    (code) => {
      test.each(['{', '', '{}', '{"content":""}'])(
        'denies before reading invalid input %j',
        async (body) => {
          if (code === 'not-found') {
            publishMock.mockResolvedValueOnce({ kind: 'not-found' })
          } else {
            const actual =
              await vi.importActual<typeof import('~/modules/publish')>(
                '~/modules/publish',
              )
            publishMock.mockImplementation(actual.publish)
            publishPrincipalMock.mockReturnValue({
              kind: 'human',
              user: { ...requireUserMock(), selfUploadEnabled: false },
            })
          }
          const request = new Request(
            'https://artifactshare.test/api/cli/artifacts/abc123def4/append',
            { method: 'POST', body },
          )
          const readBody = vi.spyOn(request, 'json')
          const waitUntil = vi.fn()
          const response = await action({
            context: new Map([[ctxContextMock, { waitUntil }]]),
            params: { id: 'abc123def4' },
            request,
          } as never)

          await expectApiError(response, {
            status: code === 'not-found' ? 404 : 403,
            code,
          })
          expect(readBody).not.toHaveBeenCalled()
          expect(waitUntil).not.toHaveBeenCalled()
        },
      )
    },
  )

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
    [{ kind: 'forbidden' }, 403, 'forbidden'],
    [{ kind: 'self-upload-disabled' }, 403, 'self-upload-disabled'],
    [{ kind: 'storage-failed' }, 502, 'storage-failed'],
    [{ kind: 'quota-exceeded' }, 413, 'quota-exceeded'],
    [{ kind: 'copy-forbidden' }, 403, 'copy-forbidden'],
  ] as const)(
    'maps publish failure %j to the existing CLI error contract',
    async (result, status, code) => {
      publishMock.mockResolvedValueOnce(result)
      const response = await action({
        context: new Map([[ctxContextMock, { waitUntil: vi.fn() }]]),
        params: { id: 'abc123def4' },
        request: new Request(
          'https://artifactshare.test/api/cli/artifacts/abc123def4/append',
          { method: 'POST', body: JSON.stringify({ content: 'added' }) },
        ),
      } as never)

      await expectApiError(response, { status, code })
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

    const error = await expectApiError(response, {
      status: 409,
      code: 'version_conflict',
      details: { current_version_id: 'v-current' },
    })
    // The person retrying by hand reads the current version from the message.
    expect(error?.message).toContain('v-current')
  })
})
