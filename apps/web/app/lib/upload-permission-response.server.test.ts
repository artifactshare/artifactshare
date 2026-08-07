import { describe, expect, test, vi } from 'vitest'

vi.mock('cloudflare:workers', () => ({
  env: { APP_ENV: 'development' },
}))

import { uploadPermissionFailureResponse } from './upload-permission-response.server'

async function json(response: Response) {
  return await response.json()
}

describe('upload permission failure responses', () => {
  test('maps self-upload disabled to self-upload-disabled', async () => {
    const response = uploadPermissionFailureResponse({
      kind: 'self-upload-disabled',
    })

    expect(response.status).toBe(403)
    await expect(json(response)).resolves.toMatchObject({
      error: { code: 'self-upload-disabled' },
    })
  })

  test('maps policy denial to upload-not-allowed', async () => {
    const response = uploadPermissionFailureResponse({ kind: 'not-allowed' })

    expect(response.status).toBe(403)
    await expect(json(response)).resolves.toMatchObject({
      error: { code: 'upload-not-allowed' },
    })
  })

  test('maps missing production binding to policy unavailable and logs', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    try {
      const response = uploadPermissionFailureResponse({
        kind: 'missing-flagship-binding',
      })

      expect(response.status).toBe(503)
      await expect(json(response)).resolves.toMatchObject({
        error: { code: 'upload-policy-unavailable' },
      })
      expect(errorSpy).toHaveBeenCalledWith(
        'upload_flagship_binding_missing_in_production',
      )
    } finally {
      errorSpy.mockRestore()
    }
  })

  test('maps Flagship evaluation failures to policy unavailable and logs', async () => {
    const error = new Error('flagship unavailable')
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    try {
      const response = uploadPermissionFailureResponse({
        kind: 'flagship-error',
        error,
      })

      expect(response.status).toBe(503)
      await expect(json(response)).resolves.toMatchObject({
        error: { code: 'upload-policy-unavailable' },
      })
      expect(errorSpy).toHaveBeenCalledWith(
        'upload_flagship_evaluation_failed',
        error,
      )
    } finally {
      errorSpy.mockRestore()
    }
  })
})
