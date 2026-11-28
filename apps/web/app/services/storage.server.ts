import {
  PDF_MIME_TYPE,
  VIDEO_MIME_TYPE,
  type SingleFileArtifactType,
} from '~/lib/artifact-type'

export interface StoredArtifact {
  body: ReadableStream<Uint8Array> | null
  text(): Promise<string>
  httpMetadata?: R2HTTPMetadata
  range?: R2Range
  size: number
  uploaded: Date
}

export function artifactR2Key(args: {
  shareableId: string
  versionId: string
  renderType: SingleFileArtifactType
}): string {
  if (args.renderType === 'pdf') {
    return `artifacts/${args.shareableId}/${args.versionId}/original.pdf`
  }
  if (args.renderType === 'video') {
    return `artifacts/${args.shareableId}/${args.versionId}/original.mp4`
  }
  const ext = args.renderType === 'md' ? 'md' : 'html'
  return `artifacts/${args.shareableId}/${args.versionId}/index.${ext}`
}

export function artifactContentType(
  renderType: SingleFileArtifactType,
): string {
  switch (renderType) {
    case 'md':
      return 'text/markdown; charset=utf-8'
    case 'pdf':
      return PDF_MIME_TYPE
    case 'video':
      return VIDEO_MIME_TYPE
    case 'html':
      return 'text/html; charset=utf-8'
  }
}

export async function putArtifact(
  bucket: R2Bucket,
  key: string,
  body: string | ReadableStream | ArrayBuffer | ArrayBufferView | Blob,
  options: { contentType: string },
): Promise<void> {
  await bucket.put(key, body, {
    httpMetadata: { contentType: options.contentType },
  })
}

export async function getArtifact(
  bucket: R2Bucket,
  key: string,
  options?: { range?: Headers },
): Promise<StoredArtifact | null> {
  const object = await bucket.get(key, options)
  if (!object) return null
  return {
    body: object.body,
    text: () => object.text(),
    httpMetadata: object.httpMetadata,
    range: object.range,
    size: object.size,
    uploaded: object.uploaded,
  }
}

export async function getArtifactPrefixText(
  bucket: R2Bucket,
  key: string,
  maxBytes: number,
): Promise<string | null> {
  const object = await bucket.get(key, {
    range: { offset: 0, length: maxBytes },
  })
  if (!object) return null
  const bytes = await object.bytes()
  // Short of the range limit the object ended on its own, so nothing was cut.
  const end = bytes.length < maxBytes ? bytes.length : wholeCharacterEnd(bytes)
  return new TextDecoder().decode(bytes.subarray(0, end))
}

// A read that fills the range can cut a multi-byte character in half, and
// decoding that tail yields U+FFFD. Drop those bytes instead, so the caller
// never sees a replacement character the object does not store. A stored U+FFFD
// arrives as a complete three-byte sequence, so it survives.
function wholeCharacterEnd(bytes: Uint8Array): number {
  for (let back = 1; back <= Math.min(bytes.length, 4); back += 1) {
    const start = bytes.length - back
    const lead = bytes[start]
    if (lead === undefined) break
    const needed = utf8SequenceLength(lead)
    if (needed === 0) continue
    return needed > back ? start : bytes.length
  }
  return bytes.length
}

function utf8SequenceLength(lead: number): number {
  if (lead < 0x80) return 1
  if (lead >= 0xc2 && lead <= 0xdf) return 2
  if (lead >= 0xe0 && lead <= 0xef) return 3
  if (lead >= 0xf0 && lead <= 0xf4) return 4
  return 0
}

export async function deleteArtifact(
  bucket: R2Bucket,
  key: string,
): Promise<void> {
  await bucket.delete(key)
}

export interface ListedArtifact {
  key: string
  uploaded: Date
  size: number
}

export async function listArtifacts(
  bucket: R2Bucket,
  cursor?: string,
): Promise<{ objects: ListedArtifact[]; cursor: string | null }> {
  const result = await bucket.list(cursor ? { cursor } : undefined)
  return {
    objects: result.objects.map((obj) => ({
      key: obj.key,
      uploaded: obj.uploaded,
      size: obj.size,
    })),
    cursor: result.truncated ? result.cursor : null,
  }
}

const R2_DELETE_CHUNK = 1000

export async function deleteArtifacts(
  bucket: R2Bucket,
  keys: string[],
): Promise<void> {
  if (keys.length === 0) return
  for (let i = 0; i < keys.length; i += R2_DELETE_CHUNK) {
    await bucket.delete(keys.slice(i, i + R2_DELETE_CHUNK))
  }
}

const DELETE_BY_PREFIX_MAX_PAGES = 10_000

export async function deleteArtifactsByPrefix(
  bucket: R2Bucket,
  prefix: string,
): Promise<void> {
  if (prefix === '') {
    throw new Error('deleteArtifactsByPrefix: refusing empty prefix')
  }
  let cursor: string | undefined
  for (let page = 0; page < DELETE_BY_PREFIX_MAX_PAGES; page++) {
    const listed = await bucket.list({ prefix, cursor })
    await deleteArtifacts(
      bucket,
      listed.objects.map((obj) => obj.key),
    )
    if (!listed.truncated) return
    if (!listed.cursor) {
      console.error('r2_delete_by_prefix_truncated_no_cursor', { prefix })
      return
    }
    if (listed.cursor === cursor) {
      throw new Error(
        `deleteArtifactsByPrefix: cursor did not advance (prefix=${prefix})`,
      )
    }
    cursor = listed.cursor
  }
  throw new Error(
    `deleteArtifactsByPrefix: exceeded ${DELETE_BY_PREFIX_MAX_PAGES} pages (prefix=${prefix})`,
  )
}
