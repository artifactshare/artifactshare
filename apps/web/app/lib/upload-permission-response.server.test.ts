import { describe, expect, test } from 'vitest'

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
})
