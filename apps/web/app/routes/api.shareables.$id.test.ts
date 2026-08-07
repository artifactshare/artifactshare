import { beforeEach, describe, expect, test, vi } from 'vitest'

const updateShareableMetadataMock = vi.hoisted(() => vi.fn())
const requireUserApiMiddlewareMock = vi.hoisted(() => vi.fn())
const requireUserMock = vi.hoisted(() => vi.fn())

vi.mock('~/middleware/auth', () => ({
  requireUserApiMiddleware: requireUserApiMiddlewareMock,
}))
vi.mock('~/middleware/context', () => ({
  requireUser: requireUserMock,
}))
vi.mock('~/services/db.server', () => ({
  createDb: () => ({ mocked: true }),
}))
vi.mock('~/services/shareables.server', () => ({
  updateShareableMetadata: updateShareableMetadataMock,
}))

import { action, middleware } from './api.shareables.$id'

function patchRequest(body: unknown) {
  return new Request('https://artifactshare.test/api/shareables/share1', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

function actionArgs(body: unknown) {
  return {
    request: patchRequest(body),
    params: { id: 'share1' },
    context: new Map(),
  } as never
}

async function json(response: Response) {
  return await response.json()
}

describe('/api/shareables/:id PATCH', () => {
  beforeEach(() => {
    updateShareableMetadataMock.mockReset()
    requireUserApiMiddlewareMock.mockReset()
    requireUserMock.mockReset()
    requireUserMock.mockReturnValue({
      id: 'u1',
      workspaceId: 'ws1',
      hd: 'example.com',
    })
  })

  test('success returns id and visibility', async () => {
    updateShareableMetadataMock.mockResolvedValue({ kind: 'ok' })

    const response = await action(actionArgs({ visibility: 'private' }))

    expect(response.status).toBe(200)
    await expect(json(response)).resolves.toEqual({
      id: 'share1',
      link_expires_at: null,
      visibility: 'private',
    })
    expect(updateShareableMetadataMock).toHaveBeenCalledWith(
      { mocked: true },
      { id: 'u1', workspaceId: 'ws1', hd: 'example.com' },
      'share1',
      { visibility: 'private', titleOverride: undefined },
    )
  })

  test('titleOverride-only success returns normalized titleOverride', async () => {
    updateShareableMetadataMock.mockResolvedValue({ kind: 'ok' })

    const response = await action(actionArgs({ titleOverride: '  Custom  ' }))

    expect(response.status).toBe(200)
    await expect(json(response)).resolves.toEqual({
      id: 'share1',
      link_expires_at: null,
      titleOverride: 'Custom',
    })
    expect(updateShareableMetadataMock).toHaveBeenCalledWith(
      { mocked: true },
      { id: 'u1', workspaceId: 'ws1', hd: 'example.com' },
      'share1',
      { visibility: undefined, titleOverride: 'Custom' },
    )
  })

  test.each(['public'])(
    '%s visibility is not accepted as a new setting',
    async (visibility) => {
      const response = await action(
        actionArgs({ visibility, titleOverride: 'Custom' }),
      )

      expect(response.status).toBe(400)
      await expect(json(response)).resolves.toMatchObject({
        error: { code: 'invalid-visibility' },
      })
      expect(updateShareableMetadataMock).not.toHaveBeenCalled()
    },
  )

  test('empty string titleOverride clears override', async () => {
    updateShareableMetadataMock.mockResolvedValue({ kind: 'ok' })

    const response = await action(actionArgs({ titleOverride: '   ' }))

    expect(response.status).toBe(200)
    await expect(json(response)).resolves.toEqual({
      id: 'share1',
      link_expires_at: null,
      titleOverride: null,
    })
    expect(updateShareableMetadataMock).toHaveBeenCalledWith(
      { mocked: true },
      { id: 'u1', workspaceId: 'ws1', hd: 'example.com' },
      'share1',
      { visibility: undefined, titleOverride: null },
    )
  })

  test('titleOverride over 200 chars returns 400 before service call', async () => {
    const response = await action(
      actionArgs({ titleOverride: 'a'.repeat(201) }),
    )

    expect(response.status).toBe(400)
    await expect(json(response)).resolves.toMatchObject({
      error: { code: 'title-too-long' },
    })
    expect(updateShareableMetadataMock).not.toHaveBeenCalled()
  })

  test('workspace visibility success returns id and visibility', async () => {
    updateShareableMetadataMock.mockResolvedValue({ kind: 'ok' })

    const response = await action(actionArgs({ visibility: 'workspace' }))

    expect(response.status).toBe(200)
    await expect(json(response)).resolves.toEqual({
      id: 'share1',
      link_expires_at: null,
      visibility: 'workspace',
    })
    expect(updateShareableMetadataMock).toHaveBeenCalledWith(
      { mocked: true },
      { id: 'u1', workspaceId: 'ws1', hd: 'example.com' },
      'share1',
      { visibility: 'workspace', titleOverride: undefined },
    )
  })

  test('link visibility forwards finite expiry and returns it', async () => {
    const expiry = '2026-08-01T00:00:00.000Z'
    updateShareableMetadataMock.mockResolvedValue({
      kind: 'ok',
      linkExpiresAt: expiry,
    })

    const response = await action(
      actionArgs({ visibility: 'link', link_expires_at: expiry }),
    )

    expect(response.status).toBe(200)
    await expect(json(response)).resolves.toEqual({
      id: 'share1',
      link_expires_at: expiry,
      visibility: 'link',
    })
    expect(updateShareableMetadataMock).toHaveBeenCalledWith(
      { mocked: true },
      { id: 'u1', workspaceId: 'ws1', hd: 'example.com' },
      'share1',
      {
        visibility: 'link',
        linkExpiresAt: expiry,
        titleOverride: undefined,
      },
    )
  })

  test.each([
    ['link-sharing-plan-required', 402],
    ['link-sharing-disabled', 403],
    ['link-expiry-invalid', 400],
  ] as const)('maps %s from the common service', async (kind, status) => {
    updateShareableMetadataMock.mockResolvedValue({ kind })

    const response = await action(actionArgs({ visibility: 'link' }))

    expect(response.status).toBe(status)
    await expect(json(response)).resolves.toMatchObject({
      error: { code: kind },
    })
  })

  test('workspace visibility without hd returns 400', async () => {
    requireUserMock.mockReturnValue({
      id: 'u1',
      workspaceId: 'ws1',
      hd: null,
    })

    const response = await action(actionArgs({ visibility: 'workspace' }))

    expect(response.status).toBe(400)
    await expect(json(response)).resolves.toMatchObject({
      error: { code: 'workspace-unavailable' },
    })
    expect(updateShareableMetadataMock).not.toHaveBeenCalled()
  })

  test('unsupported visibility value returns invalid-visibility', async () => {
    const response = await action(actionArgs({ visibility: 'invalid' }))

    expect(response.status).toBe(400)
    await expect(json(response)).resolves.toMatchObject({
      error: { code: 'invalid-visibility' },
    })
    expect(updateShareableMetadataMock).not.toHaveBeenCalled()
  })

  test('empty patch returns invalid-patch', async () => {
    const response = await action(actionArgs({}))

    expect(response.status).toBe(400)
    await expect(json(response)).resolves.toMatchObject({
      error: { code: 'invalid-patch' },
    })
    expect(updateShareableMetadataMock).not.toHaveBeenCalled()
  })

  test('unknown field returns 400', async () => {
    const response = await action(actionArgs({ titleOverride: 'Custom', x: 1 }))

    expect(response.status).toBe(400)
    await expect(json(response)).resolves.toMatchObject({
      error: { code: 'invalid-patch' },
    })
    expect(updateShareableMetadataMock).not.toHaveBeenCalled()
  })

  test('not-found from service maps to 404', async () => {
    updateShareableMetadataMock.mockResolvedValue({ kind: 'not-found' })

    const response = await action(actionArgs({ titleOverride: 'Custom' }))

    expect(response.status).toBe(404)
    await expect(json(response)).resolves.toMatchObject({
      error: { code: 'not-found' },
    })
  })

  test('titleOverride non-owner maps to 404', async () => {
    updateShareableMetadataMock.mockResolvedValue({ kind: 'not-found' })

    const response = await action(actionArgs({ titleOverride: 'Custom' }))

    expect(response.status).toBe(404)
    await expect(json(response)).resolves.toMatchObject({
      error: { code: 'not-found' },
    })
  })
})
