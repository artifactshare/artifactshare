import { renderTypeFromKind } from '~/lib/artifact-type'
import type { CommentThreadView } from '~/lib/comments'
import type { ArtifactKind } from '~/lib/shareable-types'

export type ArtifactSourceFormat = 'html' | 'markdown'

// Single-file docs agents edit sit well under this; the cap keeps one outsized
// artifact from flooding a model context while allowing chunked continuation.
const MAX_ARTIFACT_SOURCE_CHARS = 200_000

export function singleFileFormat(
  artifactKind: ArtifactKind,
): ArtifactSourceFormat | null {
  const renderType = renderTypeFromKind(artifactKind)
  if (renderType === 'md') return 'markdown'
  if (renderType === 'html') return 'html'
  return null
}

export function capSource(
  body: string,
  offset = 0,
): {
  content: string
  truncated: boolean
  nextOffset: number | null
} {
  const start = Math.min(Math.max(offset, 0), body.length)
  const end = Math.min(start + MAX_ARTIFACT_SOURCE_CHARS, body.length)
  let content = body.slice(start, end)
  const truncated = end < body.length
  // Do not end a truncated chunk on a lone high surrogate. The next read
  // re-includes the pair from nextOffset, so callers do not lose a character.
  if (truncated) {
    const lastUnit = content.charCodeAt(content.length - 1)
    if (lastUnit >= 0xd800 && lastUnit <= 0xdbff) {
      content = content.slice(0, -1)
    }
  }
  return {
    content,
    truncated,
    nextOffset: truncated ? start + content.length : null,
  }
}

export function toAgentCommentThread(thread: CommentThreadView) {
  return {
    id: thread.id,
    status: thread.status,
    resolved_at: thread.resolvedAt,
    created_at: thread.createdAt,
    updated_at: thread.updatedAt,
    anchor:
      thread.subject.kind === 'text'
        ? {
            kind: 'text' as const,
            quoted_text: thread.subject.quotedText,
            state: thread.subject.state,
          }
        : { kind: 'artifact' as const, quoted_text: null, state: null },
    messages: thread.messages.map((message) => ({
      message_id: message.id,
      author_name: message.author.name,
      author_email: message.author.email,
      agent: message.agent,
      body: message.body,
      created_at: message.createdAt,
      updated_at: message.updatedAt,
    })),
  }
}

export function shareUrl(baseUrl: string, id: string): string {
  return `${baseUrl.replace(/\/$/, '')}/a/${id}`
}
