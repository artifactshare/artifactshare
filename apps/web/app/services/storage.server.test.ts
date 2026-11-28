import { beforeEach, describe, expect, test, vi } from 'vitest'

const bucketMock = vi.hoisted(() => ({
  put: vi.fn(),
  get: vi.fn(),
  delete: vi.fn(),
  list: vi.fn(),
}))

vi.mock('cloudflare:workers', () => ({
  env: { BUCKET: bucketMock },
}))

import {
  artifactContentType,
  artifactR2Key,
  deleteArtifact,
  deleteArtifactsByPrefix,
  getArtifact,
  getArtifactPrefixText,
  putArtifact,
} from './storage.server'

describe('artifactR2Key', () => {
  test('builds an html key under artifacts/<shareable>/<version>/', () => {
    expect(
      artifactR2Key({
        shareableId: 's1',
        versionId: 'v1',
        renderType: 'html',
      }),
    ).toBe('artifacts/s1/v1/index.html')
  })

  test('builds a markdown key with the md extension', () => {
    expect(
      artifactR2Key({
        shareableId: 's2',
        versionId: 'v9',
        renderType: 'md',
      }),
    ).toBe('artifacts/s2/v9/index.md')
  })

  test('stores a pdf as the original file', () => {
    expect(
      artifactR2Key({
        shareableId: 's3',
        versionId: 'v2',
        renderType: 'pdf',
      }),
    ).toBe('artifacts/s3/v2/original.pdf')
  })

  test('stores a video as the original MP4 file', () => {
    expect(
      artifactR2Key({
        shareableId: 's4',
        versionId: 'v3',
        renderType: 'video',
      }),
    ).toBe('artifacts/s4/v3/original.mp4')
  })
})

describe('artifactContentType', () => {
  test('markdown uses utf-8 text/markdown', () => {
    expect(artifactContentType('md')).toBe('text/markdown; charset=utf-8')
  })

  test('html uses utf-8 text/html', () => {
    expect(artifactContentType('html')).toBe('text/html; charset=utf-8')
  })

  test('pdf uses application/pdf without a charset', () => {
    expect(artifactContentType('pdf')).toBe('application/pdf')
  })

  test('video uses video/mp4 without a charset', () => {
    expect(artifactContentType('video')).toBe('video/mp4')
  })
})

// An R2 object for a ranged read: it answers with the bytes inside the range
// through either API, so a cut character stays cut the way the real bucket
// cuts it and the prefix does not depend on how the bytes are decoded.
// A Uint8Array body stores bytes no encoder would produce.
function rangedObject(body: string | Uint8Array, maxBytes: number) {
  const stored =
    typeof body === 'string' ? new TextEncoder().encode(body) : body
  const bytes = stored.slice(0, maxBytes)
  return {
    bytes: () => Promise.resolve(bytes),
    text: () => Promise.resolve(new TextDecoder().decode(bytes)),
  }
}

describe('R2 wrapper', () => {
  beforeEach(() => {
    bucketMock.put.mockReset()
    bucketMock.get.mockReset()
    bucketMock.delete.mockReset()
    bucketMock.list.mockReset()
  })

  const fakeBucket = bucketMock as unknown as R2Bucket

  test('putArtifact forwards content type via httpMetadata', async () => {
    bucketMock.put.mockResolvedValue(undefined)

    await putArtifact(fakeBucket, 'artifacts/s/v/index.html', 'body', {
      contentType: 'text/html; charset=utf-8',
    })

    expect(bucketMock.put).toHaveBeenCalledWith(
      'artifacts/s/v/index.html',
      'body',
      {
        httpMetadata: { contentType: 'text/html; charset=utf-8' },
      },
    )
  })

  test('getArtifact returns null when bucket has no object', async () => {
    bucketMock.get.mockResolvedValue(null)

    const result = await getArtifact(fakeBucket, 'missing')

    expect(result).toBeNull()
  })

  test('getArtifact exposes body / text / size from the R2 object', async () => {
    bucketMock.get.mockResolvedValue({
      body: null,
      text: () => Promise.resolve('hello'),
      httpMetadata: { contentType: 'text/markdown; charset=utf-8' },
      size: 5,
      uploaded: new Date('2026-05-22T00:00:00.000Z'),
    })

    const result = await getArtifact(fakeBucket, 'artifacts/s/v/index.md')

    expect(result).not.toBeNull()
    expect(result?.size).toBe(5)
    await expect(result?.text()).resolves.toBe('hello')
    expect(result?.httpMetadata?.contentType).toBe(
      'text/markdown; charset=utf-8',
    )
  })

  test('getArtifactPrefixText reads a byte range and returns text', async () => {
    bucketMock.get.mockResolvedValue(rangedObject('prefix body', 65536))

    const result = await getArtifactPrefixText(
      fakeBucket,
      'artifacts/s/v/index.md',
      65536,
    )

    expect(bucketMock.get).toHaveBeenCalledWith('artifacts/s/v/index.md', {
      range: { offset: 0, length: 65536 },
    })
    expect(result).toBe('prefix body')
  })

  test('getArtifactPrefixText drops a trailing replacement char from a split UTF-8 tail', async () => {
    const body = '本文の途中で切れた末尾の文字本'
    // Stop one byte short of the last character, so the read cuts it in three.
    const maxBytes = new TextEncoder().encode(body).length - 1
    bucketMock.get.mockResolvedValue(rangedObject(body, maxBytes))

    const result = await getArtifactPrefixText(fakeBucket, 'a/b/c.md', maxBytes)

    expect(result).toBe('本文の途中で切れた末尾の文字')
  })

  test.each(['é', '本', '😀'])(
    'getArtifactPrefixText drops %s however the range cuts it',
    async (character) => {
      const prefix = 'kept text '
      const width = new TextEncoder().encode(character).length
      for (let kept = 1; kept < width; kept += 1) {
        const maxBytes = prefix.length + kept
        bucketMock.get.mockResolvedValue(
          rangedObject(`${prefix}${character}`, maxBytes),
        )

        await expect(
          getArtifactPrefixText(fakeBucket, 'a/b/c.md', maxBytes),
        ).resolves.toBe(prefix)
      }
    },
  )

  test('getArtifactPrefixText keeps replacement chars the object itself stores', async () => {
    const body = 'abc��'
    const stored = new TextEncoder().encode(body).length

    // The read fills the range exactly, so the prefix looks cut, yet every
    // stored replacement char arrived as a whole three-byte sequence.
    bucketMock.get.mockResolvedValue(rangedObject(body, stored))
    await expect(
      getArtifactPrefixText(fakeBucket, 'a/b/c.md', stored),
    ).resolves.toBe(body)

    bucketMock.get.mockResolvedValue(rangedObject(body, 65536))
    await expect(
      getArtifactPrefixText(fakeBucket, 'a/b/c.md', 65536),
    ).resolves.toBe(body)
  })

  // Bytes no character can start, and whole sequences that decode to nothing,
  // are content the object stores rather than damage the range cut did. They
  // stay, and the decoder turns each into a replacement char.
  test.each([
    ['continuation bytes all the way back', [0x61, 0x80, 0x80, 0x80, 0x80], 4],
    ['a byte no character starts with', [0x61, 0xff], 1],
    ['one stray continuation byte', [0x61, 0x80], 1],
    ['a whole sequence that is no character', [0x61, 0xed, 0xa0, 0x80], 3],
  ])(
    'getArtifactPrefixText keeps %s at the tail',
    async (_tail, stored, replacements) => {
      const bytes = new Uint8Array(stored)
      // The read fills the range exactly, so the prefix looks cut.
      bucketMock.get.mockResolvedValue(rangedObject(bytes, bytes.length))

      await expect(
        getArtifactPrefixText(fakeBucket, 'a/b/c.md', bytes.length),
      ).resolves.toBe(`a${'�'.repeat(replacements)}`)
    },
  )

  test('getArtifactPrefixText drops a cut sequence that was no character either', async () => {
    // ED A0 80 decodes to nothing, yet the range cut still split it, so the
    // tail goes the way any cut character's tail goes.
    const bytes = new Uint8Array([0x61, 0xed, 0xa0])
    bucketMock.get.mockResolvedValue(rangedObject(bytes, bytes.length))

    await expect(
      getArtifactPrefixText(fakeBucket, 'a/b/c.md', bytes.length),
    ).resolves.toBe('a')
  })

  test('getArtifactPrefixText returns null when the object is missing', async () => {
    bucketMock.get.mockResolvedValue(null)

    const result = await getArtifactPrefixText(fakeBucket, 'missing', 65536)

    expect(result).toBeNull()
  })

  test('deleteArtifact forwards the key to the bucket.delete', async () => {
    bucketMock.delete.mockResolvedValue(undefined)

    await deleteArtifact(fakeBucket, 'artifacts/s/v/index.html')

    expect(bucketMock.delete).toHaveBeenCalledWith('artifacts/s/v/index.html')
  })

  test('deleteArtifactsByPrefix logs when R2 truncates without a cursor', async () => {
    bucketMock.list.mockResolvedValue({
      objects: [{ key: 'prefix/a.txt' }],
      truncated: true,
      cursor: '',
    })
    bucketMock.delete.mockResolvedValue(undefined)
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    await deleteArtifactsByPrefix(fakeBucket, 'prefix/')

    expect(bucketMock.delete).toHaveBeenCalledWith(['prefix/a.txt'])
    expect(errSpy).toHaveBeenCalledWith(
      'r2_delete_by_prefix_truncated_no_cursor',
      { prefix: 'prefix/' },
    )
    errSpy.mockRestore()
  })
})
