import { beforeEach, expect, test, vi } from 'vitest'

vi.mock('cloudflare:workers', () => ({ env: {} }))
vi.mock('~/services/auth.server', () => ({
  authHandlerWithHangDetection: vi.fn(),
  getSessionUser: vi.fn(),
}))
import { authHandlerWithHangDetection } from '~/services/auth.server'
import { action } from './api.auth.$'

beforeEach(() => vi.clearAllMocks())

test.each([
  undefined,
  null,
  '',
  '   ',
  '<script>',
  'Dashboard\nName',
  'a'.repeat(101),
])(
  'invalid publisher name %j explains requirements before authorization creation',
  async (deviceName) => {
    const response = await action({
      url: new URL('https://example.test/api/auth/device/code'),
      request: new Request('https://example.test/api/auth/device/code', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_id: 'artifactshare-cli',
          preset: 'publisher',
          device_name: deviceName,
        }),
      }),
    } as never)
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({
      error: 'invalid_request',
      error_description:
        'Device name must contain 1–100 characters of letters, marks, numbers, spaces and ._-().',
    })
    expect(authHandlerWithHangDetection).not.toHaveBeenCalled()
  },
)

test.each([
  '/api/auth/sign-in/email-otp',
  '/api/auth/email-otp/check-verification-otp',
])('%s keeps running past a client abort', async (path) => {
  let finish = (_response: Response) => {}
  vi.mocked(authHandlerWithHangDetection).mockReturnValue(
    new Promise((resolve) => (finish = resolve)),
  )
  const anchored: Promise<unknown>[] = []
  const url = new URL(`https://example.test${path}`)
  const pending = action({
    url,
    request: new Request(url, { method: 'POST' }),
    context: {
      get: () => ({
        waitUntil: (promise: Promise<unknown>) => anchored.push(promise),
      }),
    },
  } as never)
  expect(anchored).toHaveLength(1)
  let settled = false
  void anchored[0].then(() => (settled = true))
  await Promise.resolve()
  expect(settled).toBe(false)
  finish(new Response('ok'))
  await pending
  await anchored[0]
  expect(settled).toBe(true)
})

test('other auth posts are not anchored', async () => {
  vi.mocked(authHandlerWithHangDetection).mockResolvedValue(new Response('ok'))
  const waitUntil = vi.fn()
  const url = new URL('https://example.test/api/auth/sign-in/social')
  await action({
    url,
    request: new Request(url, { method: 'POST' }),
    context: { get: () => ({ waitUntil }) },
  } as never)
  expect(waitUntil).not.toHaveBeenCalled()
})
