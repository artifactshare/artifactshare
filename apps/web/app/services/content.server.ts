import { env } from 'cloudflare:workers'
import type { ArtifactType } from '~/lib/artifact-type'
import { previewExcerpt } from '~/lib/preview-excerpt'
import { renderMarkdownDocument } from '~/lib/markdown-render'
import type { ArtifactKind } from '~/lib/shareable-types'
import { singleFileFormat } from './artifact-readback.server'
import { getArtifact, getArtifactPrefixText } from './storage.server'

const MAX_SOURCE_SCAN_BYTES = 64 * 1024

export type FetchAndRenderContentResult =
  | { kind: 'ok'; html: string }
  | { kind: 'not-found' }

export async function fetchAndRenderContent(args: {
  r2Key: string
  renderType: ArtifactType
}): Promise<FetchAndRenderContentResult> {
  const object = await getArtifact(env.BUCKET, args.r2Key)
  if (!object) return { kind: 'not-found' }
  const raw = await object.text()
  return {
    kind: 'ok',
    html: args.renderType === 'md' ? renderMarkdownDocument(raw) : raw,
  }
}

export type FetchArtifactSourceResult =
  | { kind: 'ok'; body: string; sizeBytes: number }
  | { kind: 'not-found' }

// The raw stored source, with no markdown render. The MCP `get_artifact` tool
// hands this back so an agent can read the exact bytes it would round-trip
// through `update_artifact` — rendering to HTML would corrupt that loop.
export async function loadPreviewExcerpt(
  r2Key: string,
  kind: ArtifactKind,
): Promise<string | null> {
  const format = singleFileFormat(kind)
  if (format !== 'markdown' && format !== 'html') return null
  const prefix = await getArtifactPrefixText(
    env.BUCKET,
    r2Key,
    MAX_SOURCE_SCAN_BYTES,
  )
  if (prefix === null) return null
  return previewExcerpt(prefix, format)
}

export async function fetchArtifactSource(
  r2Key: string,
): Promise<FetchArtifactSourceResult> {
  const object = await getArtifact(env.BUCKET, r2Key)
  if (!object) return { kind: 'not-found' }
  return { kind: 'ok', body: await object.text(), sizeBytes: object.size }
}

export async function fetchArtifactSourceBytes(
  r2Key: string,
): Promise<
  { kind: 'ok'; body: ArrayBuffer; sizeBytes: number } | { kind: 'not-found' }
> {
  const object = await getArtifact(env.BUCKET, r2Key)
  if (!object?.body) return { kind: 'not-found' }
  return {
    kind: 'ok',
    body: await new Response(object.body).arrayBuffer(),
    sizeBytes: object.size,
  }
}
