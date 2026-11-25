import { afterEach, expect, test, vi } from 'vitest'
import { sandboxBlockReportMiddleware } from './sandbox-block-report.server'
import { sessionMiddleware } from './auth'
import { RouterContextProvider } from 'react-router'
const getSessionUser = vi.hoisted(() => vi.fn())
const createDb = vi.hoisted(() => vi.fn())
vi.mock('~/services/db.server', () => ({ createDb }))
const readBearerSessionToken = vi.hoisted(() =>
  vi.fn(
    (request: Request) =>
      request.headers.get('authorization')?.replace(/^Bearer /u, '') ?? null,
  ),
)
vi.mock('~/services/auth.server', () => ({
  getSessionUser,
  readBearerSessionToken,
}))
vi.mock('cloudflare:workers', () => ({ env: {} }))

afterEach(() => {
  vi.clearAllMocks()
  vi.restoreAllMocks()
})

test.each(['abc123def4', 'example%ZZ', '%', '%E0%A4%A'])(
  'direct router rejection for %s bypasses session lookup even with cookies and forged admission',
  async (id) => {
    const request = new Request(
      `https://example.test/api/shareables/${id}/sandbox-block-report.data?admitted=1`,
      {
        method: 'POST',
        headers: {
          Origin: 'https://example.test',
          cookie: 'better-auth.session_token=secret',
          'CF-Connecting-IP': '203.0.113.10',
          'X-Report-Admitted': 'true',
        },
        body: '{}',
      },
    )
    const args = {
      request,
      url: new URL(request.url),
      context: new RouterContextProvider(),
      params: {},
      pattern: '',
    }
    const next = vi.fn(async () => new Response('next'))
    const response = await sandboxBlockReportMiddleware(args, async () =>
      sessionMiddleware(args, next),
    )
    expect((response as Response).status).toBe(503)
    expect(getSessionUser).not.toHaveBeenCalled()
    expect(createDb).not.toHaveBeenCalled()
    expect(next).not.toHaveBeenCalled()
  },
)

test.each([
  [true, 'Bearer session-token', true],
  [true, undefined, false],
  [false, 'Bearer session-token', false],
])(
  'unrelated paths retain session handling (sampled %s, bearer %s)',
  async (sampled, authorization, hasBearer) => {
    vi.spyOn(Math, 'random').mockReturnValue(sampled ? 0 : 1)
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    getSessionUser.mockResolvedValue(null)
    const request = new Request('https://example.test/settings', {
      headers: authorization ? { authorization } : {},
    })
    const args = {
      request,
      url: new URL(request.url),
      context: new RouterContextProvider(),
      params: {},
      pattern: '',
    }
    const next = vi.fn(async () => new Response('next'))
    await sandboxBlockReportMiddleware(args, async () =>
      sessionMiddleware(args, next),
    )
    expect(getSessionUser).toHaveBeenCalledWith(request)
    expect(next).toHaveBeenCalledOnce()
    if (!sampled) {
      expect(log).not.toHaveBeenCalled()
      return
    }
    expect(log).toHaveBeenCalledOnce()
    expect(JSON.parse(String(log.mock.calls[0]![0]))).toMatchObject({
      event: 'auth_session_observation',
      routeGroup: 'page',
      hasBearer,
      hasSessionToken: false,
    })
  },
)
