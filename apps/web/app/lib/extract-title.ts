import { decodeBasicHtmlEntities } from './html-entities'

const TITLE_SCAN_WINDOW = 16 * 1024
const TITLE_MAX_LENGTH = 200

export function extractTitleFromHtml(content: string): string | null {
  const head = content.slice(0, TITLE_SCAN_WINDOW)
  const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(head)
  if (!match) return null
  return normalizeTitle(decodeBasicHtmlEntities(match[1]))
}

export function extractTitleFromMarkdown(content: string): string | null {
  const head = content.slice(0, TITLE_SCAN_WINDOW)
  const { frontmatter, bodyStart } = splitFrontmatter(head)
  const frontmatterTitle = frontmatter
    ? extractFrontmatterTitle(frontmatter)
    : null
  if (frontmatterTitle !== null) return frontmatterTitle

  const lines = head.slice(bodyStart).split(/\r?\n/)
  let inFence = false
  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence
      continue
    }
    if (inFence) continue
    const match = /^#{1,6}\s+(.+)$/.exec(line)
    if (!match) continue
    const title = normalizeTitle(match[1])
    if (title !== null) return title
  }
  return null
}

export function extractTitle(
  content: string,
  kind: 'html' | 'md',
): string | null {
  return kind === 'html'
    ? extractTitleFromHtml(content)
    : extractTitleFromMarkdown(content)
}

export function extractTitleFromBytes(
  buffer: ArrayBuffer,
  kind: 'html' | 'md',
  context: { shareableId?: string; fileName?: string } = {},
): string | null {
  let content: string
  try {
    content = decodeUtf8Prefix(buffer, TITLE_SCAN_WINDOW)
  } catch (err) {
    console.warn('extract_title_decode_failed', {
      shareable_id: context.shareableId,
      file_name: context.fileName,
      err_name: err instanceof Error ? err.name : typeof err,
    })
    return null
  }
  return extractTitle(content, kind)
}

function decodeUtf8Prefix(buffer: ArrayBuffer, byteLimit: number): string {
  const decoder = new TextDecoder('utf-8', { fatal: true })
  const end = Math.min(buffer.byteLength, byteLimit)
  const prefix = buffer.slice(0, end)
  try {
    return decoder.decode(prefix)
  } catch (err) {
    if (buffer.byteLength <= end) throw err
    for (let trim = 1; trim <= 3 && end - trim >= 0; trim++) {
      try {
        return decoder.decode(buffer.slice(0, end - trim))
      } catch {
        // Keep trimming only the possible trailing partial code point.
      }
    }
    throw err
  }
}

function splitFrontmatter(content: string): {
  frontmatter: string | null
  bodyStart: number
} {
  if (!content.startsWith('---\n') && !content.startsWith('---\r\n')) {
    return { frontmatter: null, bodyStart: 0 }
  }
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content)
  if (!match) return { frontmatter: null, bodyStart: 0 }
  return { frontmatter: match[1], bodyStart: match[0].length }
}

function extractFrontmatterTitle(frontmatter: string): string | null {
  const match = /^title:\s*(.+)$/m.exec(frontmatter)
  if (!match) return null
  return normalizeTitle(stripWrappingQuotes(match[1]))
}

function stripWrappingQuotes(value: string): string {
  const trimmed = value.trim()
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1)
  }
  return trimmed
}

function normalizeTitle(value: string): string | null {
  const trimmed = value.trim()
  if (!trimmed) return null
  return trimmed.slice(0, TITLE_MAX_LENGTH)
}
