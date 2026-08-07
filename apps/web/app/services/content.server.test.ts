import { beforeEach, describe, expect, test, vi } from 'vitest'

const bucketMock = vi.hoisted(() => ({
  get: vi.fn(),
}))

vi.mock('cloudflare:workers', () => ({
  env: { BUCKET: bucketMock },
}))

import { loadPreviewExcerpt } from './content.server'

describe('loadPreviewExcerpt', () => {
  beforeEach(() => {
    bucketMock.get.mockReset()
  })

  test('reads only the first 64KB via ranged bucket.get', async () => {
    const textMock = vi
      .fn()
      .mockResolvedValue(
        '# Hello\n\nThis is enough text for preview excerpt generation here.',
      )
    bucketMock.get.mockResolvedValue({ text: textMock })

    const result = await loadPreviewExcerpt(
      'artifacts/s/v/index.md',
      'markdown_page',
    )

    expect(bucketMock.get).toHaveBeenCalledTimes(1)
    expect(bucketMock.get).toHaveBeenCalledWith('artifacts/s/v/index.md', {
      range: { offset: 0, length: 65536 },
    })
    expect(textMock).toHaveBeenCalledTimes(1)
    expect(result).toBe(
      'Hello This is enough text for preview excerpt generation here.',
    )
  })

  test('returns null when the object is missing', async () => {
    bucketMock.get.mockResolvedValue(null)

    expect(
      await loadPreviewExcerpt('artifacts/s/v/index.md', 'markdown_page'),
    ).toBeNull()
  })

  test('returns null for non single-file artifact kinds', async () => {
    expect(
      await loadPreviewExcerpt('artifacts/s/v/index.html', 'spa'),
    ).toBeNull()
    expect(bucketMock.get).not.toHaveBeenCalled()
  })
})
