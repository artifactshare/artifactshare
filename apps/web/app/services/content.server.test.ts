import { beforeEach, describe, expect, test, vi } from 'vitest'

type Range = { offset: number; length: number }

const stored = vi.hoisted(
  () => new Map<string, string>() as Map<string, string>,
)
const requests = vi.hoisted(() => [] as Array<{ key: string; range?: Range }>)

// An R2 stand-in that honours the byte range and answers through either API,
// so the excerpt depends on the bytes read and not on how they are decoded.
const bucketMock = vi.hoisted(() => ({
  get(key: string, options?: { range?: Range }) {
    requests.push({ key, range: options?.range })
    const body = stored.get(key)
    if (body === undefined) return Promise.resolve(null)
    const bytes = new TextEncoder().encode(body)
    const { offset, length } = options?.range ?? {
      offset: 0,
      length: bytes.length,
    }
    const read = bytes.slice(offset, offset + length)
    return Promise.resolve({
      size: bytes.length,
      range: options?.range,
      text: () => Promise.resolve(new TextDecoder().decode(read)),
      arrayBuffer: () => Promise.resolve(read.buffer),
      bytes: () => Promise.resolve(read),
    })
  },
}))

vi.mock('cloudflare:workers', () => ({
  env: { BUCKET: bucketMock },
}))

import { loadPreviewExcerpt } from './content.server'

describe('loadPreviewExcerpt', () => {
  beforeEach(() => {
    stored.clear()
    requests.length = 0
  })

  test('excerpts the stored markdown', async () => {
    stored.set(
      'artifacts/s/v/index.md',
      '# Hello\n\nThis is enough text for preview excerpt generation here.',
    )

    expect(
      await loadPreviewExcerpt('artifacts/s/v/index.md', 'markdown_page'),
    ).toBe('Hello This is enough text for preview excerpt generation here.')
    expect(requests).toEqual([
      {
        key: 'artifacts/s/v/index.md',
        range: { offset: 0, length: 65536 },
      },
    ])
  })

  test('reads no further than the first 64KB', async () => {
    stored.set(
      'artifacts/s/v/long.md',
      `${' '.repeat(65_536)}Text that lives past the scanned prefix.`,
    )

    // Only blank bytes fall inside the scanned prefix, so there is no excerpt.
    expect(
      await loadPreviewExcerpt('artifacts/s/v/long.md', 'markdown_page'),
    ).toBeNull()
  })

  test('does not leave a replacement character when the range cuts a character', async () => {
    stored.set('artifacts/s/v/cut.md', `${'a'.repeat(65_535)}😀`)

    const excerpt = await loadPreviewExcerpt(
      'artifacts/s/v/cut.md',
      'markdown_page',
    )
    expect(excerpt).not.toContain('�')
  })

  test('returns null when the object is missing', async () => {
    expect(
      await loadPreviewExcerpt('artifacts/s/v/index.md', 'markdown_page'),
    ).toBeNull()
  })

  test('returns null for non single-file artifact kinds', async () => {
    stored.set('artifacts/s/v/index.html', '<h1>Report</h1>')

    expect(
      await loadPreviewExcerpt('artifacts/s/v/index.html', 'spa'),
    ).toBeNull()
    expect(requests).toEqual([])
  })
})
