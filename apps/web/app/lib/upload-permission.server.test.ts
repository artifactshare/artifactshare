import { describe, expect, test, vi } from 'vitest'

vi.mock('cloudflare:workers', () => ({
  env: { APP_ENV: 'development' },
}))

import {
  checkUploadPermission,
  UPLOAD_ALLOWED_FLAG_KEY,
} from './upload-permission.server'

describe('upload permission allowlist', () => {
  const user = {
    id: 'owner-1',
    email: 'Owner@Example.com',
    workspaceId: 'ws-a',
    hd: 'Example.com',
  }

  test('allows users when Flagship returns true', async () => {
    const getBooleanValue = vi.fn().mockResolvedValue(true)

    expect(
      await checkUploadPermission(user, {
        APP_ENV: 'production',
        FLAGS: { getBooleanValue },
      }),
    ).toEqual({ kind: 'allowed' })
    expect(getBooleanValue).toHaveBeenCalledWith(
      UPLOAD_ALLOWED_FLAG_KEY,
      false,
      {
        targetingKey: 'owner-1',
        userId: 'owner-1',
        email: 'owner@example.com',
        workspaceId: 'ws-a',
        hd: 'example.com',
      },
    )
  })

  test('omits hd from the Flagship context when it is absent', async () => {
    const getBooleanValue = vi.fn().mockResolvedValue(true)

    await checkUploadPermission(
      { ...user, hd: null },
      {
        APP_ENV: 'production',
        FLAGS: { getBooleanValue },
      },
    )

    expect(getBooleanValue).toHaveBeenCalledWith(
      'upload-allowed',
      false,
      expect.not.objectContaining({ hd: expect.anything() }),
    )
  })

  test('omits email from the Flagship context when it is absent', async () => {
    const getBooleanValue = vi.fn().mockResolvedValue(true)

    await checkUploadPermission(
      { ...user, email: null },
      {
        APP_ENV: 'production',
        FLAGS: { getBooleanValue },
      },
    )

    expect(getBooleanValue).toHaveBeenCalledWith(
      'upload-allowed',
      false,
      expect.not.objectContaining({ email: expect.anything() }),
    )
  })

  test('rejects users when Flagship returns false', async () => {
    expect(
      await checkUploadPermission(user, {
        APP_ENV: 'development',
        FLAGS: { getBooleanValue: vi.fn().mockResolvedValue(false) },
      }),
    ).toEqual({ kind: 'not-allowed' })
  })

  test('allows local and test uploads when the binding is missing', async () => {
    expect(
      await checkUploadPermission(user, { APP_ENV: 'development' }),
    ).toEqual({ kind: 'allowed' })
  })

  test('uses the default Cloudflare env source', async () => {
    await expect(checkUploadPermission(user)).resolves.toEqual({
      kind: 'allowed',
    })
  })

  test('fails closed in production when the binding is missing', async () => {
    expect(
      await checkUploadPermission(user, { APP_ENV: 'production' }),
    ).toEqual({ kind: 'missing-flagship-binding' })
  })

  test('fails closed in production when the binding is malformed', async () => {
    expect(
      await checkUploadPermission(user, {
        APP_ENV: 'production',
        FLAGS: {},
      }),
    ).toEqual({ kind: 'missing-flagship-binding' })
  })

  test('fails closed when Flagship evaluation throws', async () => {
    const error = new Error('flagship unavailable')

    expect(
      await checkUploadPermission(user, {
        APP_ENV: 'development',
        FLAGS: { getBooleanValue: vi.fn().mockRejectedValue(error) },
      }),
    ).toEqual({ kind: 'flagship-error', error })
  })
})
