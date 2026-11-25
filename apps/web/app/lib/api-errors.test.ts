import { describe, expect, test } from 'vitest'
import { selfUploadDisabledResponse } from './api-errors'

describe('selfUploadDisabledResponse', () => {
  test('refuses the upload with a code a client can branch on', async () => {
    const response = selfUploadDisabledResponse()

    expect(response.status).toBe(403)
    const body = (await response.json()) as {
      error: { code: string; message: string }
    }
    expect(body.error.code).toBe('self-upload-disabled')
    expect(body.error.message.trim()).not.toBe('')
  })
})
