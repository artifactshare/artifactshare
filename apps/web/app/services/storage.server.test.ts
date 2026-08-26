import { beforeEach, describe, expect, test, vi } from 'vitest'

const bucketMock = vi.hoisted(() => ({
  put: vi.fn(),
  get: vi.fn(),
  delete: vi.fn(),
  head: vi.fn(),
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
  headArtifact,
  listArtifacts,
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
})

describe('artifactContentType', () => {
  test('markdown uses utf-8 text/markdown', () => {
    expect(artifactContentType('md')).toBe('text/markdown; charset=utf-8')
  })

  test('html uses utf-8 text/html', () => {
    expect(artifactContentType('html')).toBe('text/html; charset=utf-8')
  })
})

describe('R2 wrapper', () => {
  beforeEach(() => {
    bucketMock.put.mockReset()
    bucketMock.get.mockReset()
    bucketMock.delete.mockReset()
    bucketMock.head.mockReset()
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
    const textMock = vi.fn().mockResolvedValue('prefix body')
    bucketMock.get.mockResolvedValue({ text: textMock })

    const result = await getArtifactPrefixText(
      fakeBucket,
      'artifacts/s/v/index.md',
      65536,
    )

    expect(bucketMock.get).toHaveBeenCalledWith('artifacts/s/v/index.md', {
      range: { offset: 0, length: 65536 },
    })
    expect(textMock).toHaveBeenCalledTimes(1)
    expect(result).toBe('prefix body')
  })

  test('getArtifactPrefixText drops a trailing replacement char from a split UTF-8 tail', async () => {
    bucketMock.get.mockResolvedValue({
      text: vi.fn().mockResolvedValue('本文の途中で切れた末尾の文字�'),
    })

    const result = await getArtifactPrefixText(fakeBucket, 'a/b/c.md', 65536)

    expect(result).toBe('本文の途中で切れた末尾の文字')
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

  test('headArtifact forwards the key to the bucket.head', async () => {
    bucketMock.head.mockResolvedValue(null)

    await headArtifact(fakeBucket, 'artifacts/s/v/index.html')

    expect(bucketMock.head).toHaveBeenCalledWith('artifacts/s/v/index.html')
  })

  test('listArtifacts scopes a paginated request to the supplied prefix', async () => {
    bucketMock.list.mockResolvedValue({
      objects: [],
      truncated: false,
    })

    await listArtifacts(fakeBucket, 'next-page', 'artifacts/')

    expect(bucketMock.list).toHaveBeenCalledWith({
      cursor: 'next-page',
      prefix: 'artifacts/',
    })
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
