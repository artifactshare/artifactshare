import { renderHtml } from '@tanstack/markdown/html'
import { parseMarkdown } from '@tanstack/markdown/parser'

import { httpAutolinkExtension } from './markdown-autolink'
import { renderMarkdown } from './markdown'
import {
  highlightTanStackCode,
  TANSTACK_HIGHLIGHT_CSS,
} from './tanstack-highlight.server'

export type MarkdownRenderer = 'marked' | 'tanstack'

export function renderMarkdownBody(
  source: string,
  renderer: MarkdownRenderer,
): string {
  if (renderer === 'marked') return renderMarkdown(source)

  const parsed = parseMarkdown(source, {
    allowHtml: true,
    extensions: [httpAutolinkExtension],
    headingIds: uniqueHeadingId(),
  })
  return embedYouTube(highlightCode(renderHtml(parsed, { allowHtml: false })))
}

function uniqueHeadingId() {
  const counts = new Map<string, number>()
  return (text: string) => {
    const base =
      text
        .normalize('NFKC')
        .toLowerCase()
        .replace(/[^\p{Letter}\p{Number}]+/gu, '-')
        .replace(/^-|-$/g, '') || 'section'
    const count = (counts.get(base) ?? 0) + 1
    counts.set(base, count)
    return count === 1 ? base : `${base}-${count}`
  }
}

function highlightCode(html: string): string {
  return html.replace(
    /<pre[^>]*><code class="language-([^" ]+)">([\s\S]*?)<\/code><\/pre>/g,
    (original, language: string, encodedCode: string) => {
      if (language === 'mermaid') return original
      return highlightTanStackCode(decodeHtml(encodedCode), language).html
    },
  )
}

function decodeHtml(value: string) {
  return value
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replace(/&#(?:3)9;|&#x27;/g, "'")
    .replaceAll('&amp;', '&')
}

function embedYouTube(html: string) {
  return html.replace(
    /<p><a href="(https:\/\/(?:www\.)?(?:youtube\.com\/watch\?v=|youtu\.be\/)([A-Za-z0-9_-]{11}))"[^>]*>\1<\/a><\/p>/g,
    (_match, _url: string, videoId: string) =>
      `<div class="md-video"><iframe src="https://www.youtube-nocookie.com/embed/${videoId}" title="YouTube video" sandbox="allow-scripts allow-same-origin" allow="encrypted-media; picture-in-picture; fullscreen" loading="lazy" referrerpolicy="strict-origin" allowfullscreen></iframe></div>`,
  )
}

export const TANSTACK_MARKDOWN_CSS = TANSTACK_HIGHLIGHT_CSS
