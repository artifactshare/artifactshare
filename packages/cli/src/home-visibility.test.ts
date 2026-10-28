import { expect, test, vi } from 'vitest'
import { networkError } from './errors.js'
import { apiGet } from './api.js'
import { resolveAccountHomeVisibility } from './home-visibility.js'
vi.mock('./api.js', () => ({ apiGet: vi.fn() }))

test.each([false, true, undefined, null, 'false'])(
  'only an explicit false capability selects private (%s)',
  async (capability) => {
    vi.mocked(apiGet).mockResolvedValue({
      body: {
        workspace: { hosted_domain: null, visibility_available: capability },
      },
    })
    const result = await resolveAccountHomeVisibility(
      { value: 'workspace', source: 'product_default' },
      'test-token',
      {},
      {},
      { credentialSource: 'token_option' },
    )
    expect(result).toEqual({
      value: capability === false ? 'private' : 'workspace',
      source: 'product_default',
      privateDefault: capability === false,
    })
    expect(apiGet).toHaveBeenLastCalledWith(
      '/api/cli/whoami',
      'test-token',
      {},
      {},
      { credentialSource: 'token_option' },
    )
  },
)

test.each(['explicit', 'repository', 'user'] as const)(
  'preserves %s audiences without a request',
  async (source) => {
    vi.mocked(apiGet).mockClear()
    expect(
      await resolveAccountHomeVisibility(
        { value: 'workspace', source },
        'test-token',
        {},
        {},
        {},
      ),
    ).toEqual({ value: 'workspace', source, privateDefault: false })
    expect(apiGet).not.toHaveBeenCalled()
  },
)

test('propagates capability failures before upload', async () => {
  const error = networkError(new Error('Unavailable'))
  vi.mocked(apiGet).mockResolvedValue({ error })
  expect(
    await resolveAccountHomeVisibility(
      { value: 'workspace', source: 'product_default' },
      'test-token',
      {},
      {},
      {},
    ),
  ).toEqual({ error })
})
