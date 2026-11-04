import { expect, test } from 'vitest'
import {
  authorizePreview,
  bearer,
  createPreviewAuth,
  sameCapability,
} from './auth.js'

test('capabilities are independent 256-bit secrets with strict bearer parsing', () => {
  const first = createPreviewAuth()
  const second = createPreviewAuth()
  expect(
    new Set([...Object.values(first), ...Object.values(second)]).size,
  ).toBe(6)
  for (const value of Object.values(first)) {
    expect(value).toMatch(/^[a-f0-9]{64}$/)
    expect(bearer(`Bearer ${value}`)).toBe(value)
    for (const malformed of [
      value,
      `bearer ${value}`,
      `Bearer ${value} `,
      `Bearer ${value.slice(1)}`,
    ])
      expect(bearer(malformed)).toBeNull()
    expect(sameCapability(second.shell, value)).toBe(false)
  }
})

test('roles cannot escalate to document, shell, control or share authority', () => {
  const auth = createPreviewAuth()
  expect(authorizePreview(auth, auth.document, 'GET', '/artifact')).toBe(true)
  expect(authorizePreview(auth, auth.shell, 'GET', '/events')).toBe(true)
  expect(authorizePreview(auth, auth.control, 'POST', '/api/agent/next')).toBe(
    true,
  )
  expect(authorizePreview(auth, auth.document, 'GET', '/')).toBe(false)
  expect(authorizePreview(auth, auth.shell, 'POST', '/api/agent/next')).toBe(
    false,
  )
  expect(authorizePreview(auth, auth.control, 'POST', '/api/popup')).toBe(false)
  expect(authorizePreview(auth, auth.control, 'GET', '/artifact')).toBe(false)
  expect(authorizePreview(auth, auth.control, 'GET', '/api/annotations')).toBe(
    false,
  )
  expect(authorizePreview(auth, auth.control, 'GET', '/api/agent/state')).toBe(
    true,
  )
})
