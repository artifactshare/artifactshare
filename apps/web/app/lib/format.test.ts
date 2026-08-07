import { describe, expect, test } from 'vitest'
import { formatBytes } from './format'

describe('formatBytes', () => {
  test('B / KB / MB / GB の境界を正しくフォーマットする', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(1024)).toBe('1 KB')
    expect(formatBytes(2048)).toBe('2 KB')
    expect(formatBytes(1024 * 1024)).toBe('1.0 MB')
    expect(formatBytes(1.5 * 1024 * 1024)).toBe('1.5 MB')
    expect(formatBytes(1024 * 1024 * 1024)).toBe('1.0 GB')
    expect(formatBytes(50 * 1024 * 1024 * 1024)).toBe('50.0 GB')
  })
})
