import { describe, expect, test } from 'vitest'
import { computeFileSha256, computeTextSha256Hex } from './sha256'

describe('computeFileSha256', () => {
  test('returns the known digest for a string body', async () => {
    await expect(computeFileSha256(new Blob(['hello']))).resolves.toBe(
      'LPJNul-wow4m6DsqxbninhsWHlwfp0JecwQzYpOLmCQ',
    )
  })

  test('handles empty input', async () => {
    await expect(computeFileSha256(new Blob([]))).resolves.toBe(
      '47DEQpj8HBSa-_TImW-5JCeuQeRkm5NMpJWZG3hSuFU',
    )
  })
})

describe('computeTextSha256Hex', () => {
  test('returns the known hex digest for text', async () => {
    await expect(computeTextSha256Hex('hello')).resolves.toBe(
      '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
    )
  })
})
