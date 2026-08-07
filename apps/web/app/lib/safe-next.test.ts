import { describe, expect, test } from 'vitest'
import {
  hasSafeArtifactInviteNext,
  hasSafeInternalNext,
  safeInternalNext,
} from './safe-next'

describe('safeInternalNext', () => {
  test.each([
    [null, false],
    ['/a/abc123', true],
    ['https://evil.com', false],
  ] as const)('checks raw next boundaries: %s', (next, expected) => {
    expect(hasSafeInternalNext(next)).toBe(expected)
  })
  test('keeps an internal absolute path', () => {
    expect(safeInternalNext('/a/abc123')).toBe('/a/abc123')
    expect(safeInternalNext('/')).toBe('/')
  })

  test('rejects protocol-relative and backslash paths that escape the origin', () => {
    expect(safeInternalNext('//evil.com')).toBe('/')
    expect(safeInternalNext('/\\evil.com')).toBe('/')
  })

  test('rejects absolute URLs and non-paths', () => {
    expect(safeInternalNext('https://evil.com')).toBe('/')
    expect(safeInternalNext('evil.com')).toBe('/')
    expect(safeInternalNext('')).toBe('/')
  })

  test('rejects non-string input', () => {
    expect(safeInternalNext(null)).toBe('/')
    expect(safeInternalNext(undefined)).toBe('/')
    expect(safeInternalNext(42)).toBe('/')
  })

  test.each([
    ['/a/example', true],
    ['/pricing', false],
    ['/', false],
    ['https://evil.com', false],
  ] as const)(
    'only treats artifact invites as locale exceptions: %s',
    (next, expected) => {
      expect(hasSafeArtifactInviteNext(next)).toBe(expected)
    },
  )
})
