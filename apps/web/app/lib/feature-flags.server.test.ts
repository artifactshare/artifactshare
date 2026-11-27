import { describe, expect, test, vi } from 'vitest'

import { isFlagKeyOn, isFlagOn } from './feature-flags.server'

vi.mock('cloudflare:workers', () => ({ env: {} }))

const FLAG_KEY = 'test-flag'
const CONTEXT = { targetingKey: 'ws1', workspaceId: 'ws1' }

describe('isFlagKeyOn', () => {
  test('production fails closed when the binding is missing', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    await expect(
      isFlagKeyOn({ APP_ENV: 'production' }, FLAG_KEY, CONTEXT),
    ).resolves.toBe(false)
    expect(error).toHaveBeenCalledWith(
      'feature_flag_binding_missing_in_production',
      FLAG_KEY,
    )
    error.mockRestore()
  })

  test('production ignores DEV_FLAGS when the binding is missing', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    await expect(
      isFlagKeyOn(
        { APP_ENV: 'production', DEV_FLAGS: FLAG_KEY },
        FLAG_KEY,
        CONTEXT,
      ),
    ).resolves.toBe(false)
    error.mockRestore()
  })

  test.each([
    [undefined, false],
    [FLAG_KEY, true],
    [` ${FLAG_KEY} `, true],
    [`other-flag,${FLAG_KEY},third-flag`, true],
    ['other-flag,third-flag', false],
    [`${FLAG_KEY}=on`, false],
    [`some-mode=on,${FLAG_KEY}`, true],
  ])(
    'outside production without a binding, DEV_FLAGS %j reads as %s',
    async (devFlags, expected) => {
      await expect(
        isFlagKeyOn(
          { APP_ENV: 'development', DEV_FLAGS: devFlags },
          FLAG_KEY,
          CONTEXT,
        ),
      ).resolves.toBe(expected)
    },
  )

  test('treats a missing APP_ENV as non-production', async () => {
    await expect(
      isFlagKeyOn({ DEV_FLAGS: FLAG_KEY }, FLAG_KEY, CONTEXT),
    ).resolves.toBe(true)
  })

  test('evaluates through the binding when it is present', async () => {
    const getBooleanValue = vi.fn().mockResolvedValue(true)
    await expect(
      isFlagKeyOn(
        { APP_ENV: 'development', DEV_FLAGS: '', FLAGS: { getBooleanValue } },
        FLAG_KEY,
        CONTEXT,
      ),
    ).resolves.toBe(true)
    expect(getBooleanValue).toHaveBeenCalledWith(FLAG_KEY, false, CONTEXT)
  })

  test('fails closed and logs when the binding throws', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const failure = new Error('flag error')
    const getBooleanValue = vi.fn().mockRejectedValue(failure)
    await expect(
      isFlagKeyOn(
        { APP_ENV: 'production', FLAGS: { getBooleanValue } },
        FLAG_KEY,
        CONTEXT,
      ),
    ).resolves.toBe(false)
    expect(error).toHaveBeenCalledWith(
      'feature_flag_evaluation_failed',
      FLAG_KEY,
      failure,
    )
    error.mockRestore()
  })
})

describe('isFlagOn', () => {
  test('targets a workspace flag by workspace id', async () => {
    const getBooleanValue = vi.fn().mockResolvedValue(true)
    await expect(
      isFlagOn(
        'bot-members',
        { workspaceId: 'ws1' },
        { APP_ENV: 'production', FLAGS: { getBooleanValue } },
      ),
    ).resolves.toBe(true)
    expect(getBooleanValue).toHaveBeenCalledWith('bot-members', false, {
      targetingKey: 'ws1',
      workspaceId: 'ws1',
    })
  })

  test('targets a host flag by hostname and path', async () => {
    const getBooleanValue = vi.fn().mockResolvedValue(false)
    await expect(
      isFlagOn(
        'maintenance',
        { hostname: 'artifactshare.com', pathname: '/home' },
        { APP_ENV: 'production', FLAGS: { getBooleanValue } },
      ),
    ).resolves.toBe(false)
    expect(getBooleanValue).toHaveBeenCalledWith('maintenance', false, {
      targetingKey: 'artifactshare.com',
      hostname: 'artifactshare.com',
      pathname: '/home',
    })
  })
})
