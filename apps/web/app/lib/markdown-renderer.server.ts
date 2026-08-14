import { renderHtml } from '@tanstack/markdown/html'
import { parseMarkdown } from '@tanstack/markdown/parser'

import { httpAutolinkExtension } from './markdown-autolink'
import { markdownDisclosureExtension } from './markdown-disclosure'
import {
  highlightTanStackCode,
  TANSTACK_HIGHLIGHT_CSS,
} from './tanstack-highlight.server'

const markdownExtensions = [markdownDisclosureExtension, httpAutolinkExtension]

export function renderMarkdownBody(source: string): string {
  const parsed = parseMarkdown(source, {
    allowHtml: true,
    extensions: markdownExtensions,
    headingIds: uniqueHeadingId(),
  })
  return embedYouTube(
    highlightCode(
      renderHtml(parsed, {
        allowHtml: false,
        extensions: markdownExtensions,
      }),
    ),
  )
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
  const highlighted = html.replace(
    /<pre([^>]*)><code(?: class="language-([^" ]+)")?>([\s\S]*?)<\/code><\/pre>/g,
    (
      original,
      attributes: string,
      matchedLanguage: string | undefined,
      encodedCode: string,
    ) => {
      const language = matchedLanguage ?? 'text'
      const title =
        readAttribute(attributes, 'data-code-title') ??
        readAttribute(attributes, 'data-filename')
      const label = title ?? language
      const renderedCode =
        language === 'mermaid'
          ? original
          : highlightTanStackCode(decodeHtml(encodedCode), language).html
      return `<figure class="md-code-block" data-lang="${escapeAttribute(language)}"><figcaption class="md-code-toolbar"><span class="md-code-label">${escapeHtml(label)}</span><button type="button" class="md-code-copy" data-code-copy aria-label="Copy code">Copy</button></figcaption>${renderedCode}</figure>`
    },
  )
  return highlighted.replace(
    /<figure class="tm-code-frame"[^>]*><figcaption>[\s\S]*?<\/figcaption>(<figure class="md-code-block"[\s\S]*?<\/figure>)<\/figure>/g,
    '$1',
  )
}

function readAttribute(attributes: string, name: string) {
  const match = attributes.match(new RegExp(`\\s${name}="([^"]*)"`))
  return match ? decodeHtml(match[1]) : null
}

function escapeAttribute(value: string) {
  return escapeHtml(value)
}

function escapeHtml(value: string) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#x27;')
}

function decodeHtml(value: string) {
  return value
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&#96;', '`')
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

export const MARKDOWN_HIGHLIGHT_CSS = TANSTACK_HIGHLIGHT_CSS
