import { decodeBasicHtmlEntities } from './html-entities'

const MIN_EXCERPT_CHARS = 20
export const MAX_EXCERPT_CHARS = 140
const MAX_SOURCE_SCAN_CHARS = 64 * 1024

export function previewExcerpt(
  source: string,
  format: 'markdown' | 'html',
): string | null {
  const scanSource =
    source.length > MAX_SOURCE_SCAN_CHARS
      ? source.slice(0, MAX_SOURCE_SCAN_CHARS)
      : source
  const plain =
    format === 'markdown'
      ? markdownToPlain(scanSource)
      : htmlToPlain(scanSource)
  const collapsed = collapseWhitespace(plain)
  if (collapsed.length < MIN_EXCERPT_CHARS) return null
  return truncateExcerpt(collapsed, MAX_EXCERPT_CHARS)
}

function markdownToPlain(source: string): string {
  let text = source
  text = text.replace(/```[\s\S]*?```/g, '')
  text = text.replace(/~~~[\s\S]*?~~~/g, '')
  text = text.replace(/!\[[^\]]*\]\([^)]*\)/g, '')
  text = text.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
  text = text.replace(/`([^`]+)`/g, '$1')
  text = text.replace(/^#{1,6}\s+/gm, '')
  text = text.replace(/^>\s?/gm, '')
  text = text.replace(/^[\t ]*[-*+]\s+/gm, '')
  text = text.replace(/^[\t ]*\d+\.\s+/gm, '')
  text = text.replace(/(\*{1,2}|_{1,2}|~{1,2})/g, '')
  text = text.replace(/\|/g, ' ')
  return text
}

function htmlToPlain(source: string): string {
  let text = source
  text = text.replace(/<!--[\s\S]*?-->/g, '')
  text = text.replace(/<script[\s\S]*?<\/script>/gi, '')
  text = text.replace(/<style[\s\S]*?<\/style>/gi, '')
  text = text.replace(/<[^>]*>/g, '')
  return decodeBasicHtmlEntities(text)
}

// og:description など、最小長ゲートなしで HTML から抜粋を取りたい呼び出し向け。
// ブロック要素の境界だけ空白にし、インラインタグは詰めて句読点前の空白を避ける。
export function htmlExcerpt(source: string, maxChars: number): string {
  const withBlockBreaks = source.replace(
    /<\/(?:p|li|h[1-6]|blockquote|pre|tr|div)>/gi,
    ' ',
  )
  return truncateExcerpt(
    collapseWhitespace(htmlToPlain(withBlockBreaks)),
    maxChars,
  )
}

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

function truncateExcerpt(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  let truncated = text.slice(0, maxChars)
  const lastUnit = truncated.charCodeAt(truncated.length - 1)
  if (lastUnit >= 0xd800 && lastUnit <= 0xdbff) {
    truncated = truncated.slice(0, -1)
  }
  return `${truncated}…`
}
