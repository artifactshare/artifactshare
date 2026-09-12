import { describe, expect, test } from 'vitest'

import { checkUploadAccess } from './upload-access.server'

const user = {
  id: 'u1',
  email: 'u1@example.com',
  workspaceId: 'ws1',
  selfUploadEnabled: true,
  hd: null,
}

describe('checkUploadAccess', () => {
  test('self-upload enabled grants access', async () => {
    expect((await checkUploadAccess(user)).kind).toBe('allowed')
  })

  test('self-upload disabled rejects access', async () => {
    const viewer = { ...user, selfUploadEnabled: false }
    expect((await checkUploadAccess(viewer)).kind).toBe('self-upload-disabled')
  })

  test('missing selfUploadEnabled fails closed', async () => {
    expect(
      (await checkUploadAccess({ ...user, selfUploadEnabled: undefined })).kind,
    ).toBe('self-upload-disabled')
  })
})
