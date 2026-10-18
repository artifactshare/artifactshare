import { afterEach, expect, test, vi } from 'vitest'
import { sandboxBlockReportMiddleware } from './sandbox-block-report.server'
import { sessionMiddleware } from './auth'
import { RouterContextProvider } from 'react-router'
const getSessionUser = vi.hoisted(() => vi.fn())
const readBearerSessionToken = vi.hoisted(() => vi.fn(() => null))
vi.mock('~/services/auth.server', () => ({
  getSessionUser,
  readBearerSessionToken,
}))
vi.mock('cloudflare:workers', () => ({ env: {} }))

afterEach(() => {
  vi.clearAllMocks()
  vi.restoreAllMocks()
})

test('direct router rejection bypasses session lookup even with cookies and forged admission', async () => {
  const request = new Request(
    'https://example.test/api/shareables/abc123def4/sandbox-block-report.data?admitted=1',
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
  expect(next).not.toHaveBeenCalled()
})

test.each([false, true])(
  'unrelated paths retain session handling with observation sampled=%s',
  async (sampled) => {
    vi.spyOn(Math, 'random').mockReturnValue(sampled ? 0 : 1)
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    getSessionUser.mockResolvedValue(null)
    const request = new Request('https://example.test/settings')
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
    expect(readBearerSessionToken).toHaveBeenCalledTimes(sampled ? 1 : 0)
    if (sampled) {
      expect(readBearerSessionToken).toHaveBeenCalledWith(request)
      expect(log).toHaveBeenCalledWith(
        expect.stringContaining('"event":"auth_session_observation"'),
      )
    } else {
      expect(log).not.toHaveBeenCalled()
    }
  },
)
