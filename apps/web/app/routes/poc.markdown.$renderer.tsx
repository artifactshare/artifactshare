import { Marked } from 'marked'
import { useEffect, useRef } from 'react'
import { Link, useLoaderData } from 'react-router'
import { renderHtml } from '@tanstack/markdown/html'
import { parseMarkdown } from '@tanstack/markdown/parser'
import type { BlockNode, InlineNode } from '@tanstack/markdown'

import { httpAutolinkExtension } from '~/lib/markdown-autolink'
import { enableMarkdownFragmentNavigation } from '~/lib/markdown-fragment-navigation.client'

const MARKED_VERSION = '18.0.6'
const TANSTACK_VERSION = '0.0.13'
const YOUTUBE_VIDEO_ID = 'aqz-KE-bpKQ'

export const MARKDOWN_LAB_SOURCE = `---
title: Markdown renderer lab
author: Artifact Share
lang: ja
---

# Markdown Renderer Lab

日本語の文章を、文節を意識しながら読みやすく折り返せるか確認します。狭い画面でも本文全体が横へはみ出さないことが大切です。

## 同じ見出し

最初の同名見出しです。コメント位置の比較対象になる文章をここに置きます。

## 同じ見出し

二番目の同名見出しです。コメント位置の比較対象になる文章をここに置きます。

## Long URL

https://example.com/a/very/long/path/that/keeps/going/without/a/convenient/break/point?first=abcdefghijklmnopqrstuvwxyz&second=012345678901234567890123456789

## Wide table

| Package | Renderer | Frontmatter | Table of contents | Highlight | Mermaid | YouTube | Comment anchors |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Marked | HTML string | shared step | shared headings | follow-up | follow-up | follow-up | measured |
| TanStack Markdown | HTML string | shared step | document headings | follow-up | follow-up | follow-up | measured |

## Code

\`\`\`ts
export function rendererName(value: string) {
  return value.toUpperCase()
}
\`\`\`

## Deferred source samples

\`\`\`mermaid
flowchart LR
  Source --> Renderer --> HTML
\`\`\`

<div onclick="alert('not allowed')">Raw HTML stays visible as source.</div>

<iframe src="https://www.youtube-nocookie.com/embed/${YOUTUBE_VIDEO_ID}"></iframe>
`

type RendererName = 'marked' | 'tanstack'
type Heading = { id: string; text: string; level: number }

type RenderedLab = {
  renderer: RendererName
  version: string
  sourceHash: string
  document: string
  articleHtml: string
  headings: Heading[]
  renderSource: string
  youtubeVideoId: string
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

export function splitFrontmatter(source: string) {
  const lines = source.split('\n')
  if (lines[0] !== '---')
    return { originalSource: source, metadataLines: [], renderSource: source }
  const close = lines.indexOf('---', 1)
  if (close < 0)
    return { originalSource: source, metadataLines: [], renderSource: source }
  return {
    originalSource: source,
    metadataLines: lines.slice(1, close).filter((line) => line.trim()),
    renderSource: lines
      .slice(close + 1)
      .join('\n')
      .replace(/^\n/, ''),
  }
}

function createSlugger() {
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

export function renderMarked(source: string) {
  const headings: Heading[] = []
  const slug = createSlugger()
  const marked = new Marked({
    gfm: true,
    breaks: false,
    renderer: {
      html({ text }) {
        return escapeHtml(text)
      },
      heading({ depth, tokens }) {
        const content = this.parser.parseInline(tokens)
        const headingText = htmlToPlainText(content)
        const id = slug(headingText)
        headings.push({ id, text: headingText, level: depth })
        return `<h${depth} id="${escapeHtml(id)}">${content}</h${depth}>\n`
      },
    },
  })
  const html = marked.parse(source, { async: false }) as string
  return { html, headings }
}

function htmlToPlainText(value: string) {
  return value
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
    .replaceAll('&amp;', '&')
    .replace(/<[^>]+>/g, '')
}

export function renderTanStack(source: string) {
  const slug = createSlugger()
  const parsed = parseMarkdown(source, {
    allowHtml: true,
    extensions: [httpAutolinkExtension],
    headingIds: (text) => slug(text),
  })
  return {
    html: renderHtml(parsed, { allowHtml: false }),
    headings: collectHeadings(parsed.children),
  }
}

function collectHeadings(nodes: BlockNode[]): Heading[] {
  return nodes.flatMap((node) => {
    if (node.type === 'heading' && node.id)
      return [
        { id: node.id, text: inlineText(node.children), level: node.depth },
      ]
    if (
      node.type === 'blockquote' ||
      node.type === 'callout' ||
      node.type === 'component'
    )
      return collectHeadings(node.children)
    if (node.type === 'list')
      return node.items.flatMap((item) => collectHeadings(item.children))
    if (node.type === 'footnotes')
      return node.items.flatMap((item) => collectHeadings(item.children))
    return []
  })
}

function inlineText(nodes: InlineNode[]): string {
  return nodes
    .map((node) => {
      if (node.type === 'inlineHtml') return ''
      if ('value' in node) return node.value
      if ('children' in node) return inlineText(node.children)
      if (node.type === 'image') return node.alt
      return ''
    })
    .join('')
}

function buildDocument(
  metadataLines: string[],
  headings: Heading[],
  articleHtml: string,
  highlightCss: string,
) {
  const metadata = metadataLines.length
    ? `<section class="metadata"><h2>Frontmatter</h2><dl>${metadataLines
        .map((line) => {
          const separator = line.indexOf(':')
          const key = separator < 0 ? line : line.slice(0, separator)
          const value = separator < 0 ? '' : line.slice(separator + 1).trim()
          return `<div><dt>${escapeHtml(key)}</dt><dd>${escapeHtml(value)}</dd></div>`
        })
        .join('')}</dl></section>`
    : ''
  const toc = headings.length
    ? `<nav aria-label="Table of contents"><h2>Contents</h2><ol>${headings
        .map(
          (heading) =>
            `<li class="level-${heading.level}"><a href="#${escapeHtml(heading.id)}">${escapeHtml(heading.text)}</a></li>`,
        )
        .join('')}</ol></nav>`
    : ''
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${LAB_CSS}\n${highlightCss}</style></head><body><div class="viewer-shell"><aside>${metadata}${toc}</aside><article id="lab-article">${articleHtml}</article></div></body></html>`
}

async function sha256(value: string) {
  const bytes = new TextEncoder().encode(value)
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('')
}

export async function loader({ params }: { params: { renderer?: string } }) {
  if (params.renderer !== 'marked' && params.renderer !== 'tanstack')
    throw new Response('Not found', { status: 404 })

  const renderer = params.renderer
  const { originalSource, metadataLines, renderSource } =
    splitFrontmatter(MARKDOWN_LAB_SOURCE)
  const result =
    renderer === 'marked'
      ? renderMarked(renderSource)
      : renderTanStack(renderSource)
  const { enhanceHtml, TANSTACK_HIGHLIGHT_CSS } =
    await import('./markdown-lab.server')
  const articleHtml = await enhanceHtml(result.html, renderer)
  return {
    renderer,
    version: renderer === 'marked' ? MARKED_VERSION : TANSTACK_VERSION,
    sourceHash: await sha256(originalSource),
    document: buildDocument(
      metadataLines,
      result.headings,
      articleHtml,
      renderer === 'tanstack' ? TANSTACK_HIGHLIGHT_CSS : '',
    ),
    articleHtml,
    headings: result.headings,
    renderSource,
    youtubeVideoId: YOUTUBE_VIDEO_ID,
  } satisfies RenderedLab
}

export function meta() {
  return [
    { title: 'Markdown renderer lab · Artifact Share' },
    { name: 'robots', content: 'noindex, nofollow' },
  ]
}

export default function MarkdownRendererLab() {
  const data = useLoaderData<typeof loader>()
  const frameRef = useRef<HTMLIFrameElement>(null)

  useEffect(() => {
    if (frameRef.current) prepareMarkdownFrame(frameRef.current)
  }, [data.document])

  return (
    <main className="bg-background text-foreground min-h-dvh px-4 py-6 sm:px-6">
      <div className="mx-auto flex max-w-6xl flex-col gap-4">
        <header className="flex flex-col gap-3">
          <div>
            <p className="text-muted-foreground text-sm">Disposable PoC</p>
            <h1 className="text-2xl font-semibold">Markdown renderer lab</h1>
          </div>
          <nav aria-label="Renderer" className="flex gap-2">
            {(['marked', 'tanstack'] as const).map((renderer) => (
              <Link
                key={renderer}
                to={`/poc/markdown/${renderer}`}
                aria-current={data.renderer === renderer ? 'page' : undefined}
                className="border-border aria-[current=page]:bg-foreground aria-[current=page]:text-background rounded-md border px-3 py-2 text-sm"
              >
                {renderer === 'marked' ? 'Marked' : 'TanStack Markdown'}
              </Link>
            ))}
          </nav>
          <dl className="text-muted-foreground grid gap-x-4 gap-y-1 text-xs sm:grid-cols-[auto_1fr]">
            <dt>Renderer</dt>
            <dd>{data.renderer}</dd>
            <dt>Version</dt>
            <dd>{data.version}</dd>
            <dt>Source SHA-256</dt>
            <dd className="font-mono break-all">{data.sourceHash}</dd>
          </dl>
        </header>
        <iframe
          ref={frameRef}
          title={`${data.renderer} Markdown output`}
          sandbox="allow-same-origin allow-presentation"
          srcDoc={data.document}
          onLoad={(event) => prepareMarkdownFrame(event.currentTarget)}
          className="border-border h-dvh w-full rounded-lg border bg-white"
        />
        <section className="flex flex-col gap-2">
          <h2 className="text-lg font-semibold">YouTube embed</h2>
          <iframe
            title="YouTube video"
            src={`https://www.youtube-nocookie.com/embed/${data.youtubeVideoId}`}
            sandbox="allow-scripts allow-presentation"
            allow="accelerometer; autoplay; encrypted-media; gyroscope; picture-in-picture"
            allowFullScreen
            loading="lazy"
            className="border-border aspect-video w-full rounded-lg border"
          />
        </section>
      </div>
    </main>
  )
}

function prepareMarkdownFrame(frame: HTMLIFrameElement) {
  enableMarkdownFragmentNavigation(frame)
  void renderMermaid(frame)
}

async function renderMermaid(frame: HTMLIFrameElement) {
  const document = frame.contentDocument
  if (!document || renderedMermaidDocuments.has(document)) return
  renderedMermaidDocuments.add(document)
  const blocks = document.querySelectorAll<HTMLElement>(
    'pre code.language-mermaid',
  )
  if (!blocks.length) return

  const { default: mermaid } = await import('mermaid')
  mermaid.initialize({ startOnLoad: false, securityLevel: 'strict' })
  await Promise.all(
    Array.from(blocks, async (block, index) => {
      const container = document.createElement('div')
      container.className = 'mermaid-diagram'
      try {
        const { svg } = await mermaid.render(
          `markdown-lab-${Date.now()}-${index}`,
          block.textContent ?? '',
        )
        container.innerHTML = svg
        block.parentElement?.replaceWith(container)
      } catch {
        container.classList.add('mermaid-error')
        container.textContent = 'Mermaid diagram could not be rendered.'
        block.parentElement?.replaceWith(container)
      }
    }),
  )
}

const renderedMermaidDocuments = new WeakSet<Document>()

const LAB_CSS = `
:root{color-scheme:light dark;--bg:#fff;--panel:#f6f8fa;--text:#1f2328;--muted:#59636e;--border:#d1d9e0;--code:#f6f8fa;--link:#0969da}
@media(prefers-color-scheme:dark){:root{--bg:#0d1117;--panel:#151b23;--text:#f0f6fc;--muted:#9198a1;--border:#3d444d;--code:#151b23;--link:#4493f8}}
*{box-sizing:border-box}html{scroll-behavior:smooth}html,body{margin:0;max-width:100%;overflow-x:hidden}body{background:var(--bg);color:var(--text);font-family:ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI","Noto Sans JP","Hiragino Sans","Yu Gothic UI",sans-serif;font-size:16px;line-height:1.75;padding:clamp(20px,4vw,48px);word-break:auto-phrase;overflow-wrap:anywhere}.viewer-shell{display:grid;grid-template-columns:minmax(190px,240px) minmax(0,760px);gap:clamp(32px,5vw,72px);max-width:1080px;margin-inline:auto;align-items:start}aside{position:sticky;top:24px;min-width:0;max-height:calc(100vh - 48px);overflow-y:auto}.metadata,nav{border:1px solid var(--border);border-radius:12px;padding:16px;background:var(--panel);margin-bottom:16px}.metadata h2,nav h2{font-size:.75rem;letter-spacing:.08em;text-transform:uppercase;color:var(--muted);margin:0 0 12px}.metadata dl,.metadata dd{margin:0}.metadata dl{display:grid;gap:9px}.metadata dl div{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1.5fr);gap:8px;font-size:.8rem}.metadata dt{color:var(--muted)}.metadata dd{font-weight:550;overflow-wrap:anywhere}nav ol{list-style:none;margin:0;padding:0}nav li+li{margin-top:3px}nav .level-2{padding-left:10px}nav .level-3{padding-left:20px}nav a{display:block;border-radius:6px;padding:5px 8px;color:var(--muted);font-size:.85rem;line-height:1.35;text-decoration:none}nav a:hover{color:var(--link)}nav a.active{background:var(--bg);color:var(--text);font-weight:600;box-shadow:inset 2px 0 var(--link)}#lab-article{min-width:0}a{color:var(--link)}h1,h2,h3{line-height:1.28;letter-spacing:-.018em;margin:1.8em 0 .65em;scroll-margin-top:24px}h1{font-size:clamp(2rem,5vw,3rem);font-weight:720;margin-top:0}h2{font-size:1.55rem;font-weight:680}h3{font-size:1.2rem;font-weight:650}p,pre,table{margin:0 0 1.1em}pre,.shiki{padding:16px;border-radius:8px;overflow:auto}.shiki{border:1px solid var(--border)}code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}p a{overflow-wrap:anywhere;word-break:break-word}table{display:block;width:max-content;max-width:100%;overflow-x:auto;border-collapse:collapse}th,td{min-width:140px;padding:8px 12px;border:1px solid var(--border);text-align:left}th{background:var(--code)}.mermaid-diagram{margin:0 0 1em;overflow:auto;text-align:center}.mermaid-diagram svg{max-width:100%;height:auto}.mermaid-error{color:#cf222e}
@media(max-width:720px){body{padding:20px}.viewer-shell{display:block}aside{position:static;max-height:none;overflow:visible;margin-bottom:32px}.metadata,nav{padding:14px}h1{font-size:2rem}}
`
