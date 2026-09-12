import { describe, expect, test } from 'vitest'
import { selfUploadDisabledResponse } from './api-errors'

describe('selfUploadDisabledResponse', () => {
  test('returns the current self-upload restriction', async () => {
    const response = selfUploadDisabledResponse()

    expect(response.status).toBe(403)
    await expect(response.json()).resolves.toEqual({
      error: {
        code: 'self-upload-disabled',
        message: 'Sign in with Google or Microsoft to upload files.',
      },
    })
  })
})
