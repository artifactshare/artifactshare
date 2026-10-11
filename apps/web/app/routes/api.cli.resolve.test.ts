const getCliAuthorityMock = vi.hoisted(() => vi.fn())
import type { CliAuthority } from '~/services/cli-authority.server'
import { beforeEach, describe, expect, test, vi } from 'vitest'

const requireUserApiWithBearerMiddlewareMock = vi.hoisted(() => vi.fn())
const requireUserMock = vi.hoisted(() => vi.fn())
const createDbMock = vi.hoisted(() => vi.fn())
const resolveCliCandidatesMock = vi.hoisted(() => vi.fn())

vi.mock('~/middleware/auth', () => ({
  requireUserApiWithBearerMiddleware: requireUserApiWithBearerMiddlewareMock,
}))
vi.mock('~/middleware/context', () => ({
  requireUser: requireUserMock,
  getCliAuthority: getCliAuthorityMock,
}))
vi.mock('~/services/db.server', () => ({
  createDb: createDbMock,
  withDb: (fn: (db: unknown) => unknown) => fn(createDbMock()),
}))
vi.mock('~/services/cli-resolve.server', () => ({
  resolveCliCandidates: resolveCliCandidatesMock,
}))

import { loader, middleware } from './api.cli.resolve'

describe('/api/cli/resolve', () => {
  beforeEach(() => {
    getCliAuthorityMock.mockReset().mockReturnValue(null)
    requireUserApiWithBearerMiddlewareMock.mockReset()
    requireUserMock.mockReset()
    createDbMock.mockReset()
    resolveCliCandidatesMock.mockReset()
    createDbMock.mockReturnValue({
      destroy: vi.fn().mockResolvedValue(undefined),
    })
    requireUserMock.mockReturnValue({
      id: 'u1',
      email: 'owner@example.com',
      workspaceId: 'ws1',
      hd: 'example.com',
    })
  })

  test('denies an unknown authority for GET before accessing artifact or project data', async () => {
    getCliAuthorityMock.mockReturnValue({
      kind: 'unknown',
    } as unknown as CliAuthority)
    const response = await loader({
      context: new Map(),
      params: {},
      request: new Request('https://example.test/api/cli/resolve?q=report', {
        method: 'GET',
      }),
    } as never)
    expect(response.status).toBe(403)
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'scope-denied' },
    })
    expect(resolveCliCandidatesMock).not.toHaveBeenCalled()
  })

  test('requires a query', async () => {
    const response = await loader({
      context: new Map(),
      request: new Request('https://example.test/api/cli/resolve?q='),
    } as never)
    const body = (await response.json()) as {
      error: { code: string; message: string }
    }

    expect(response.status).toBe(400)
    expect(body.error.code).toBe('invalid-query')
    expect(createDbMock).not.toHaveBeenCalled()
  })

  test('returns candidates for the authenticated user', async () => {
    resolveCliCandidatesMock.mockResolvedValue({
      query: 'Weekly report',
      candidates: [
        {
          kind: 'artifact',
          id: 'abc123def4',
          title: 'Weekly report',
          artifact_kind: 'markdown_page',
          visibility: 'private',
          project: null,
          owner: { id: 'u1', email: 'owner@example.com' },
          updated_at: '2026-06-18T00:00:00.000Z',
          match: { kind: 'title', confidence: 'exact' },
        },
      ],
      has_more: false,
    })

    const response = await loader({
      context: new Map(),
      request: new Request(
        'https://example.test/api/cli/resolve?q=Weekly%20report',
      ),
    } as never)
    const body = (await response.json()) as {
      query: string
      candidates: Array<{ id: string }>
      has_more: boolean
    }

    expect(response.status).toBe(200)
    expect(body.query).toBe('Weekly report')
    expect(body.candidates[0]?.id).toBe('abc123def4')
    expect(body.has_more).toBe(false)
    expect(resolveCliCandidatesMock).toHaveBeenCalledWith(
      expect.anything(),
      {
        id: 'u1',
        email: 'owner@example.com',
        workspaceId: 'ws1',
        hd: 'example.com',
      },
      'Weekly report',
    )
  })
})
