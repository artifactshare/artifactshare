import { describe, expect, test } from 'vitest'
import { uploadNotAllowedResponse } from './api-errors'

describe('uploadNotAllowedResponse', () => {
  test('describes a temporary pause without pointing to the removed waitlist', async () => {
    const response = uploadNotAllowedResponse()

    expect(response.status).toBe(403)
    await expect(response.json()).resolves.toEqual({
      error: {
        code: 'upload-not-allowed',
        message:
          'Uploads are temporarily unavailable. Contact Artifact Share support if you need help.',
      },
    })
  })
})
