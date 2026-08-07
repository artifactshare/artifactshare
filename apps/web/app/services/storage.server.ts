export interface StoredArtifact {
  body: ReadableStream<Uint8Array> | null
  text(): Promise<string>
  httpMetadata?: R2HTTPMetadata
  size: number
  uploaded: Date
}

export function artifactR2Key(args: {
  shareableId: string
  versionId: string
  renderType: 'html' | 'md'
}): string {
  const ext = args.renderType === 'md' ? 'md' : 'html'
  return `artifacts/${args.shareableId}/${args.versionId}/index.${ext}`
}

export function artifactContentType(renderType: 'html' | 'md'): string {
  return renderType === 'md'
    ? 'text/markdown; charset=utf-8'
    : 'text/html; charset=utf-8'
}

// All R2 helpers take bucket as the first argument. This keeps tests able to
// pass a mocked R2Bucket and prevents future reconciliation helpers from
// silently falling back to env.BUCKET when the caller meant to operate on a
// specific bucket instance.
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
): Promise<StoredArtifact | null> {
  const object = await bucket.get(key)
  if (!object) return null
  return {
    body: object.body,
    text: () => object.text(),
    httpMetadata: object.httpMetadata,
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
  const text = await object.text()
  // The byte range can split a multi-byte UTF-8 char at maxBytes, which decodes
  // to a trailing replacement char. Stored content is valid UTF-8, so the only
  // source of U+FFFD is that tail cut — drop it so excerpts don't end in `�`.
  return text.replace(/�+$/u, '')
}

export async function deleteArtifact(
  bucket: R2Bucket,
  key: string,
): Promise<void> {
  await bucket.delete(key)
}

export async function headArtifact(
  bucket: R2Bucket,
  key: string,
): Promise<R2Object | null> {
  return await bucket.head(key)
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

// Hard cap on pagination loop iterations. With R2 list returning up to 1000
// keys per page, 10k iterations covers ~10M objects — well beyond any single
// bundle prefix. If we ever hit this we want to fail loudly rather than spin.
const DELETE_BY_PREFIX_MAX_PAGES = 10_000

export async function deleteArtifactsByPrefix(
  bucket: R2Bucket,
  prefix: string,
): Promise<void> {
  // Empty prefix would list and delete the entire bucket. Current callers
  // construct prefixes from non-empty workspace / shareable / version ids,
  // but the guard makes the function safe against future caller miscompute.
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
    // Falsy cursor (incl. empty string) terminates even when truncated is
    // true — better to leak orphans than loop infinitely on a stuck cursor.
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
