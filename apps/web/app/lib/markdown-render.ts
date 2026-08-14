import {
  renderMarkdownBody,
  TANSTACK_MARKDOWN_CSS,
  type MarkdownRenderer,
} from './markdown-renderer.server'

// Marked keeps its existing raw-HTML behavior inside the sandbox boundary.
// TanStack escapes raw HTML and adds only the controlled embeds produced by
// markdown-renderer.server.
//
// The CSP violation reporter is injected by the response handler, not
// here — keeping render output bake-free so Workers Cache stays the
// canonical body store.
export function renderMarkdownDocument(
  source: string,
  renderer: MarkdownRenderer = 'marked',
): string {
  const startedAt = performance.now()
  const markdown = renderer === 'tanstack' ? splitFrontmatter(source) : null
  const body = renderMarkdownBody(markdown?.body ?? source, renderer)
  const navigation = markdown ? tanStackNavigation(markdown.metadata, body) : ''
  const document = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>${MD_STYLES}${renderer === 'tanstack' ? TANSTACK_MARKDOWN_CSS : ''}</style>
</head>
<body data-markdown-renderer="${renderer}"><div class="md-shell">${navigation}<article class="md" data-comment-content>${body}</article></div></body>
</html>`
  if (renderer === 'tanstack') {
    console.info('markdown_render_completed', {
      renderer,
      durationMs: Math.round((performance.now() - startedAt) * 10) / 10,
    })
  }
  return document
}

function splitFrontmatter(source: string) {
  const match = source.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)
  if (!match) return { metadata: [] as string[], body: source }
  return {
    metadata: match[1].split(/\r?\n/).filter((line) => line.trim()),
    body: source.slice(match[0].length),
  }
}

function tanStackNavigation(metadata: string[], body: string) {
  const headings = Array.from(
    body.matchAll(/<h([1-6]) id="([^"]+)">([\s\S]*?)<\/h\1>/g),
  )
  if (metadata.length === 0 && headings.length === 0) return ''
  const frontmatter = metadata.length
    ? `<section class="md-metadata" aria-label="Frontmatter"><h2>Frontmatter</h2><dl>${metadata
        .map((line) => {
          const separator = line.indexOf(':')
          const key = separator < 0 ? line : line.slice(0, separator)
          const value = separator < 0 ? '' : line.slice(separator + 1).trim()
          return `<div><dt>${escapeHtml(key)}</dt><dd>${escapeHtml(value)}</dd></div>`
        })
        .join('')}</dl></section>`
    : ''
  const toc = headings.length
    ? `<nav class="md-toc" aria-label="Table of contents"><h2>Contents</h2><ol>${headings
        .map(
          ([, level, id, text]) =>
            `<li class="level-${level}"><a href="#${escapeHtml(id)}">${plainText(text)}</a></li>`,
        )
        .join('')}</ol></nav>`
    : ''
  return `<aside class="md-sidebar" data-comment-ui>${frontmatter}${toc}</aside>`
}

function plainText(value: string) {
  return escapeHtml(
    value.replace(/<[^>]+>/g, '').replace(
      /&(?:amp|lt|gt|quot|#x27);|&#(?:3)9;/g,
      (entity) =>
        ({
          '&amp;': '&',
          '&lt;': '<',
          '&gt;': '>',
          '&quot;': '"',
          '&#x27;': "'",
          ['&' + '#' + '39;']: "'",
        })[entity] ?? entity,
    ),
  )
}

function escapeHtml(value: string) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#x27;')
}

// Inlined (~1 KB) so the sandbox iframe doesn't pay a fetch round-trip
// before first paint.
const MD_STYLES = `
:root {
  color-scheme: light dark;
  --md-text: #1f2328;
  --md-muted: #59636e;
  --md-border: #d1d9e0;
  --md-bg: #ffffff;
  --md-code-bg: #f6f8fa;
  --md-link: #0969da;
}
@media (prefers-color-scheme: dark) {
  :root {
    --md-text: #f0f6fc;
    --md-muted: #9198a1;
    --md-border: #3d444d;
    --md-bg: #0d1117;
    --md-code-bg: #151b23;
    --md-link: #4493f8;
  }
}
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; }
html { scroll-behavior: smooth; }
body {
  background: var(--md-bg);
  color: var(--md-text);
  font: 16px/1.7 "Helvetica Neue", Arial, "Hiragino Kaku Gothic ProN",
    "Hiragino Sans", "Noto Sans JP", Meiryo, sans-serif;
  -webkit-font-smoothing: antialiased;
}
.md {
  max-width: 860px;
  margin: 0 auto;
  padding: 48px 32px 96px;
}
.md-shell { max-width: 1180px; margin: 0 auto; }
.md-sidebar { padding: 24px 32px 0; color: var(--md-muted); }
.md-sidebar h2 { margin: 0 0 8px; color: var(--md-text); font-size: 0.85rem; }
.md-sidebar dl, .md-sidebar ol { margin: 0; padding: 0; list-style: none; }
.md-sidebar dl div { display: grid; grid-template-columns: minmax(5rem,auto) 1fr; gap: 12px; }
.md-sidebar dt { font-weight: 600; }
.md-sidebar dd { margin: 0; overflow-wrap: anywhere; }
.md-toc { margin-top: 24px; }
.md-toc li { margin: 4px 0; }
.md-toc .level-2 { padding-left: 12px; }
.md-toc .level-3, .md-toc .level-4, .md-toc .level-5, .md-toc .level-6 { padding-left: 24px; }
.md-toc a[aria-current="location"] { color: var(--md-text); font-weight: 600; }
@media (min-width: 980px) {
  .md-shell { display: grid; grid-template-columns: 240px minmax(0,860px); }
  .md-sidebar { position: sticky; top: 0; align-self: start; max-height: 100vh; overflow: auto; padding-top: 48px; }
}
@media (prefers-reduced-motion: reduce) { html { scroll-behavior: auto; } }
.md > :first-child { margin-top: 0; }
.md > :last-child { margin-bottom: 0; }
.md h1, .md h2, .md h3, .md h4, .md h5, .md h6 {
  margin: 32px 0 16px;
  font-weight: 600;
  font-feature-settings: "palt";
  line-height: 1.25;
  text-wrap: balance;
}
.md h1 { font-size: 2em; padding-bottom: 0.3em; border-bottom: 1px solid var(--md-border); }
.md h2 { font-size: 1.5em; padding-bottom: 0.3em; border-bottom: 1px solid var(--md-border); }
.md h3 { font-size: 1.25em; }
.md h4 { font-size: 1em; }
.md h5 { font-size: 0.875em; }
.md h6 { font-size: 0.85em; color: var(--md-muted); }
.md p, .md ul, .md ol, .md blockquote, .md pre, .md table { margin: 0 0 16px; }
.md a { color: var(--md-link); text-decoration: none; }
.md {
  overflow-wrap: anywhere;
  word-break: auto-phrase;
  line-break: strict;
}
.md a:hover { text-decoration: underline; }
.md ul, .md ol { padding-left: 2em; }
.md li + li { margin-top: 0.25em; }
.md blockquote {
  padding: 0 1em;
  color: var(--md-muted);
  border-left: 0.25em solid var(--md-border);
}
.md code {
  font: 0.85em ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-feature-settings: normal;
  background: var(--md-code-bg);
  padding: 0.2em 0.4em;
  border-radius: 6px;
}
.md pre {
  background: var(--md-code-bg);
  padding: 16px;
  overflow: auto;
  border-radius: 8px;
  line-height: 1.45;
  line-break: auto;
  overflow-wrap: normal;
  word-break: normal;
}
.md pre code {
  background: transparent;
  padding: 0;
  font-size: 0.875em;
}
.md table {
  border-collapse: collapse;
  display: block;
  width: max-content;
  max-width: 100%;
  overflow: auto;
  line-break: auto;
  overflow-wrap: normal;
  word-break: normal;
}
.md th, .md td {
  padding: 6px 13px;
  border: 1px solid var(--md-border);
}
.md th { background: var(--md-code-bg); font-weight: 600; }
.md tr:nth-child(2n) td { background: var(--md-code-bg); }
.md img { max-width: 100%; height: auto; }
.md-video { position: relative; aspect-ratio: 16 / 9; margin: 0 0 16px; }
.md-video iframe { width: 100%; height: 100%; border: 0; }
.mermaid-diagram { margin: 0 0 16px; overflow: auto; text-align: center; }
.mermaid-diagram svg { max-width: 100%; height: auto; }
.mermaid-error { border: 1px solid #cf222e; }
.md hr {
  height: 0.25em;
  margin: 24px 0;
  border: 0;
  background: var(--md-border);
}
.md kbd {
  font: 0.85em ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  background: var(--md-code-bg);
  border: 1px solid var(--md-border);
  border-bottom-width: 2px;
  border-radius: 6px;
  padding: 2px 5px;
}
.md input[type="checkbox"] { margin-right: 0.4em; }
`
