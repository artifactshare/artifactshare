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
