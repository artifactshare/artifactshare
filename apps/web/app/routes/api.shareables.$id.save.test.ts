import { beforeEach, describe, expect, test, vi } from 'vitest'

const commitDialogChangesMock = vi.hoisted(() => vi.fn())
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
  commitDialogChanges: commitDialogChangesMock,
}))

import { action, loader, middleware } from './api.shareables.$id.save'

const GRANTS = [
  {
    email: 'viewer@example.com',
    grantedAt: '2026-05-21T00:00:00.000Z',
    user: null,
  },
]

function request(method: string, body?: unknown) {
  return new Request('https://artifactshare.test/api/shareables/share1/save', {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

function actionArgs(method: string, body?: unknown) {
  return {
    request: request(method, body),
    params: { id: 'share1' },
    context: new Map(),
  } as never
}

async function json(response: Response) {
  return await response.json()
}

describe('/api/shareables/:id/save', () => {
  beforeEach(() => {
    commitDialogChangesMock.mockReset()
    requireUserApiMiddlewareMock.mockReset()
    requireUserMock.mockReset()
    requireUserMock.mockReturnValue({
      id: 'u1',
      email: 'owner@example.com',
      workspaceId: 'ws1',
      hd: 'example.com',
    })
  })

  test('success returns committed visibility and grants', async () => {
    commitDialogChangesMock.mockResolvedValue({
      kind: 'ok',
      visibility: 'workspace',
      grants: GRANTS,
      linkExpiresAt: null,
    })

    const response = await action(
      actionArgs('POST', {
        visibility: 'workspace',
        addEmails: ['Viewer@EXAMPLE.com'],
      }),
    )

    expect(response.status).toBe(200)
    await expect(json(response)).resolves.toEqual({
      visibility: 'workspace',
      grants: GRANTS,
      link_expires_at: null,
    })
    expect(commitDialogChangesMock).toHaveBeenCalledWith(
      { mocked: true },
      {
        id: 'u1',
        email: 'owner@example.com',
        workspaceId: 'ws1',
        hd: 'example.com',
      },
      'share1',
      {
        visibility: 'workspace',
        addEmails: ['Viewer@EXAMPLE.com'],
      },
    )
  })

  test.each([
    {},
    { visibility: 'bad' },
    { visibility: 'public' },
    { addEmails: [1] },
  ])('invalid payload returns 400', async (body) => {
    const response = await action(actionArgs('POST', body))

    expect(response.status).toBe(400)
    await expect(json(response)).resolves.toMatchObject({
      error: { code: 'invalid-save-body' },
    })
    expect(commitDialogChangesMock).not.toHaveBeenCalled()
  })

  test('non-owner maps to 403', async () => {
    commitDialogChangesMock.mockResolvedValue({ kind: 'not-found' })

    const response = await action(
      actionArgs('POST', { addEmails: ['viewer@example.com'] }),
    )

    expect(response.status).toBe(403)
  })

  test('service lowercases email through commit result', async () => {
    commitDialogChangesMock.mockResolvedValue({
      kind: 'ok',
      visibility: 'private',
      grants: GRANTS,
      linkExpiresAt: null,
    })

    const response = await action(
      actionArgs('POST', { addEmails: ['VIEWER@EXAMPLE.COM'] }),
    )

    expect(response.status).toBe(200)
    await expect(json(response)).resolves.toEqual({
      visibility: 'private',
      grants: GRANTS,
      link_expires_at: null,
    })
  })

  test('link visibility forwards an explicit expiry and returns it', async () => {
    const expiry = '2026-08-01T00:00:00.000Z'
    commitDialogChangesMock.mockResolvedValue({
      kind: 'ok',
      visibility: 'link',
      grants: [],
      linkExpiresAt: expiry,
    })

    const response = await action(
      actionArgs('POST', {
        visibility: 'link',
        link_expires_at: expiry,
      }),
    )

    expect(response.status).toBe(200)
    await expect(json(response)).resolves.toEqual({
      visibility: 'link',
      grants: [],
      link_expires_at: expiry,
    })
    expect(commitDialogChangesMock).toHaveBeenCalledWith(
      { mocked: true },
      expect.objectContaining({ id: 'u1' }),
      'share1',
      { visibility: 'link', linkExpiresAt: expiry },
    )
  })

  test.each([
    ['link-sharing-plan-required', 402],
    ['link-sharing-disabled', 403],
    ['link-expiry-invalid', 400],
  ] as const)('maps %s from the common service', async (kind, status) => {
    commitDialogChangesMock.mockResolvedValue({ kind })

    const response = await action(actionArgs('POST', { visibility: 'link' }))

    expect(response.status).toBe(status)
    await expect(json(response)).resolves.toMatchObject({
      error: { code: kind },
    })
  })

  test('unsupported method returns 405', async () => {
    await expect(
      action(actionArgs('DELETE', { addEmails: [] })),
    ).resolves.toHaveProperty('status', 405)
    expect(loader().status).toBe(405)
  })

  test('workspace-unavailable maps to 400', async () => {
    commitDialogChangesMock.mockResolvedValue({ kind: 'workspace-unavailable' })

    const response = await action(
      actionArgs('POST', { visibility: 'workspace' }),
    )

    expect(response.status).toBe(400)
    await expect(json(response)).resolves.toMatchObject({
      error: { code: 'workspace-unavailable' },
    })
  })

  test('too-many-grants maps to 400', async () => {
    commitDialogChangesMock.mockResolvedValue({
      kind: 'too-many-grants',
      limit: 50,
    })

    const response = await action(
      actionArgs('POST', { addEmails: ['viewer@example.com'] }),
    )

    expect(response.status).toBe(400)
    await expect(json(response)).resolves.toMatchObject({
      error: { code: 'too-many-grants' },
    })
  })

  test('commit-failed maps to 502', async () => {
    commitDialogChangesMock.mockResolvedValue({ kind: 'commit-failed' })

    const response = await action(
      actionArgs('POST', { addEmails: ['viewer@example.com'] }),
    )

    expect(response.status).toBe(502)
    await expect(json(response)).resolves.toMatchObject({
      error: { code: 'commit-failed' },
    })
  })
})
