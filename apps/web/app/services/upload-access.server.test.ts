import { afterEach, describe, expect, test, vi } from 'vitest'

const envRef = vi.hoisted(() => ({ flag: false }))

vi.mock('cloudflare:workers', () => ({
  env: {
    APP_ENV: 'production',
    FLAGS: { getBooleanValue: async () => envRef.flag },
  },
}))

import { checkUploadAccess } from './upload-access.server'

const user = {
  id: 'u1',
  email: 'u1@example.com',
  workspaceId: 'ws1',
  selfUploadEnabled: true,
  hd: null,
}

describe('checkUploadAccess', () => {
  afterEach(() => {
    envRef.flag = false
  })

  test('Flagship allow grants access', async () => {
    envRef.flag = true
    expect((await checkUploadAccess(user)).kind).toBe('allowed')
  })

  test('Flagship deny is not allowed', async () => {
    envRef.flag = false
    expect((await checkUploadAccess(user)).kind).toBe('not-allowed')
  })

  test('self-upload disabled rejects even when Flagship allows', async () => {
    envRef.flag = true
    const viewer = { ...user, selfUploadEnabled: false }
    expect((await checkUploadAccess(viewer)).kind).toBe('self-upload-disabled')
  })

  test('missing selfUploadEnabled fails closed', async () => {
    envRef.flag = true
    expect(
      (await checkUploadAccess({ ...user, selfUploadEnabled: undefined })).kind,
    ).toBe('self-upload-disabled')
  })
})
