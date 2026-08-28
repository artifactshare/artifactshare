import {
  MARKDOWN_HIGHLIGHT_CSS,
  renderMarkdownBody,
} from './markdown-renderer.js'

// The CSP violation reporter is injected by the response handler, not
// here — keeping render output bake-free so Workers Cache stays the
// canonical body store.
export interface MarkdownRenderOptions {
  /** The web renderer reports its timing to the platform log. The CLI's stdout
   * carries a single-line JSON contract, so it turns the log off rather than
   * losing the measurement for the web. */
  logTiming?: boolean
}

export function renderMarkdownDocument(
  source: string,
  options: MarkdownRenderOptions = {},
): string {
  const startedAt = performance.now()
  const markdown = splitFrontmatter(source)
  const body = renderMarkdownBody(markdown.body)
  const navigation = markdownNavigation(markdown.metadata, body)
  const document = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>${MD_STYLES}${MARKDOWN_HIGHLIGHT_CSS}</style>
</head>
<body data-artifact-markdown><div class="md-shell">${navigation}<article class="md" data-comment-content>${body}</article></div></body>
</html>`
  if (options.logTiming !== false) {
    console.info('markdown_render_completed', {
      renderer: 'tanstack',
      durationMs: Math.round((performance.now() - startedAt) * 10) / 10,
    })
  }
  return document
}

function splitFrontmatter(source: string) {
  const match = source.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)
  if (!match) return { metadata: [] as string[], body: source }
  return {
    metadata: (match[1] ?? '').split(/\r?\n/).filter((line) => line.trim()),
    body: source.slice(match[0].length),
  }
}

function markdownNavigation(metadata: string[], body: string) {
  const headings = Array.from(
    body.matchAll(/<h([1-6]) id="([^"]+)">([\s\S]*?)<\/h\1>/g),
  )
  if (metadata.length === 0 && headings.length === 0) return ''
  const frontmatter = metadata.length
    ? `<details class="md-metadata" aria-label="Frontmatter"><summary>Frontmatter</summary><dl>${metadata
        .map((line) => {
          const separator = line.indexOf(':')
          const key = separator < 0 ? line : line.slice(0, separator)
          const value = separator < 0 ? '' : line.slice(separator + 1).trim()
          return `<div><dt>${escapeHtml(key)}</dt><dd>${escapeHtml(value)}</dd></div>`
        })
        .join('')}</dl></details>`
    : ''
  const tocItems = headings
    .map(
      ([, level, id, text]) =>
        `<li class="level-${level}"><a href="#${escapeHtml(id ?? '')}">${plainText(text ?? '')}</a></li>`,
    )
    .join('')
  const toc = headings.length
    ? `<nav class="md-toc md-toc-desktop" aria-label="Table of contents"><h2>Contents</h2><ol>${tocItems}</ol></nav><details class="md-toc-mobile"><summary>Contents</summary><nav class="md-toc" aria-label="Table of contents"><ol>${tocItems}</ol></nav></details>`
    : ''
  return `<aside class="md-sidebar" data-comment-ui>${toc}${frontmatter}</aside>`
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

// Inlined so the sandbox iframe doesn't pay a stylesheet fetch before first paint.
const MD_STYLES = `
:root {
  color-scheme: light dark;
  --md-text: #37352f;
  --md-muted: rgba(55, 53, 47, 0.78);
  --md-faint: rgba(55, 53, 47, 0.72);
  --md-border: rgba(55, 53, 47, 0.12);
  --md-border-strong: rgba(55, 53, 47, 0.18);
  --md-bg: #fbfaf8;
  --md-surface: #ffffff;
  --md-muted-bg: #f7f6f3;
  --md-accent-bg: rgba(55, 53, 47, 0.04);
  --md-link-soft: rgba(35, 131, 226, 0.1);
  --md-code-bg: #f7f6f3;
  --md-code-block-bg: #0d1117;
  --md-code-block-surface: #161b22;
  --md-code-block-text: #f0f6fc;
  --md-code-block-muted: #9da7b3;
  --md-code-block-border: rgba(240, 246, 252, 0.14);
  --md-link: #116bb1;
  --md-link-hover: #125892;
  --md-radius-sm: 3px;
  --md-radius-md: 6px;
  --md-shadow-sm: rgba(15, 15, 15, 0.04) 0 0 0 1px, rgba(15, 15, 15, 0.04) 0 1px 2px;
}
@media (prefers-color-scheme: dark) {
  :root {
    --md-text: #e7e2d8;
    --md-muted: rgba(231, 226, 216, 0.77);
    --md-faint: rgba(231, 226, 216, 0.56);
    --md-border: rgba(231, 226, 216, 0.13);
    --md-border-strong: rgba(231, 226, 216, 0.24);
    --md-bg: #0e1012;
    --md-surface: #14171a;
    --md-muted-bg: #181b1e;
    --md-accent-bg: rgba(231, 226, 216, 0.07);
    --md-link-soft: rgba(125, 183, 255, 0.14);
    --md-code-bg: #181b1e;
    --md-link: #7db7ff;
    --md-link-hover: #9bc8ff;
    --md-shadow-sm: rgba(0, 0, 0, 0.32) 0 0 0 1px, rgba(0, 0, 0, 0.22) 0 1px 2px;
  }
}
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; }
html { scroll-behavior: smooth; }
body {
  background: var(--md-bg);
  color: var(--md-text);
  font: 500 16px/1.7 ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont,
    "Segoe UI", "Hiragino Sans", "Noto Sans JP", Meiryo, sans-serif,
    "Apple Color Emoji", "Segoe UI Emoji";
  -webkit-font-smoothing: antialiased;
}
.md {
  width: min(860px, calc(100% - 48px));
  max-width: 860px;
  margin: 32px auto 64px;
  padding: 48px 32px 96px;
  border: 1px solid var(--md-border);
  border-radius: 12px;
  background: var(--md-surface);
  box-shadow: var(--md-shadow-sm);
}
.md-shell { max-width: 1180px; margin: 0 auto; }
.md-sidebar { padding: 24px 32px 0; color: var(--md-muted); font-size: 0.875rem; }
.md-sidebar h2 {
  margin: 0 0 10px;
  color: var(--md-faint);
  font-size: 0.75rem;
  font-weight: 600;
  letter-spacing: 0.02em;
}
.md-sidebar summary {
  position: relative;
  color: var(--md-text);
  cursor: pointer;
  font-size: 0.8125rem;
  font-weight: 600;
  list-style: none;
  user-select: none;
}
.md-sidebar summary::-webkit-details-marker { display: none; }
.md-sidebar summary::before {
  content: "";
  display: inline-block;
  width: 6px;
  height: 6px;
  margin-right: 8px;
  border-right: 1.5px solid currentColor;
  border-bottom: 1.5px solid currentColor;
  transform: translateY(-1px) rotate(-45deg);
  transition: transform 100ms cubic-bezier(0.16, 1, 0.3, 1);
}
.md-sidebar details[open] > summary::before { transform: translateY(-2px) rotate(45deg); }
.md-sidebar summary:hover, .md-sidebar summary:active { background: var(--md-accent-bg); }
.md-sidebar summary:focus-visible, .md-sidebar a:focus-visible {
  outline: 2px solid var(--md-link);
  outline-offset: 2px;
}
.md-sidebar dl, .md-sidebar ol { margin: 0; padding: 0; list-style: none; }
.md-metadata > summary {
  padding: 8px 10px;
  border: 1px solid var(--md-border);
  border-radius: var(--md-radius-md);
  background: var(--md-surface);
  box-shadow: var(--md-shadow-sm);
}
.md-metadata[open] > summary { border-radius: var(--md-radius-md) var(--md-radius-md) 0 0; }
.md-metadata dl {
  margin-top: 0;
  padding: 10px;
  border: 1px solid var(--md-border);
  border-top: 0;
  border-radius: 0 0 var(--md-radius-md) var(--md-radius-md);
  background: var(--md-muted-bg);
}
.md-sidebar dl div { display: grid; grid-template-columns: minmax(4.5rem,auto) minmax(0,1fr); gap: 12px; padding: 5px 0; }
.md-sidebar dt { color: var(--md-faint); font-size: 0.75rem; font-weight: 600; }
.md-sidebar dd { margin: 0; color: var(--md-text); overflow-wrap: anywhere; }
.md-toc-mobile { display: none; }
.md-toc-desktop {
  padding: 12px;
  border: 1px solid var(--md-border);
  border-radius: 8px;
  background: var(--md-surface);
  box-shadow: var(--md-shadow-sm);
}
.md-sidebar li { margin: 1px 0; }
.md-sidebar a {
  display: block;
  margin-left: -8px;
  padding: 5px 8px;
  border-radius: var(--md-radius-sm);
  color: var(--md-muted);
  line-height: 1.45;
  text-decoration: none;
}
.md-sidebar a:hover { color: var(--md-text); background: var(--md-accent-bg); }
.md-sidebar a:active { color: var(--md-link-hover); background: var(--md-link-soft); }
.md-sidebar .level-2 { padding-left: 12px; }
.md-sidebar .level-3, .md-sidebar .level-4, .md-sidebar .level-5, .md-sidebar .level-6 { padding-left: 24px; }
.md-sidebar a[aria-current="location"] {
  color: var(--md-link-hover);
  background: var(--md-link-soft);
  box-shadow: inset 2px 0 var(--md-link);
  font-weight: 600;
}
@media (min-width: 980px) {
  .md-shell:has(> .md-sidebar) { display: grid; grid-template-columns: 240px minmax(0,860px); }
  .md-shell:has(> .md-sidebar) .md { width: 100%; }
  .md-sidebar { position: sticky; top: 0; align-self: start; max-height: 100vh; overflow: auto; padding-top: 32px; }
  .md-toc-mobile + .md-metadata { margin-top: 24px; }
}
@media (max-width: 979px) {
  .md-sidebar { display: flex; flex-wrap: wrap; gap: 8px; padding-bottom: 0; }
  .md-toc-desktop { display: none; }
  .md-toc-mobile { display: block; }
  .md-toc-mobile, .md-metadata { flex: 1 1 10rem; margin: 0; }
  .md-toc-mobile[open], .md-metadata[open] { flex-basis: 100%; }
  .md-toc-mobile summary, .md-metadata summary {
    padding: 8px 12px;
    border: 1px solid var(--md-border);
    border-radius: var(--md-radius-md);
    background: var(--md-surface);
    box-shadow: var(--md-shadow-sm);
  }
  .md-toc-mobile[open] summary, .md-metadata[open] summary { border-radius: var(--md-radius-md) var(--md-radius-md) 0 0; }
  .md-toc-mobile nav, .md-metadata dl {
    padding: 12px;
    border: 1px solid var(--md-border);
    border-top: 0;
    border-radius: 0 0 var(--md-radius-md) var(--md-radius-md);
    background: var(--md-muted-bg);
  }
}
@media (max-width: 699px) {
  .md {
    width: 100%;
    margin: 16px 0 0;
    padding: 32px 20px 72px;
    border-right: 0;
    border-left: 0;
    border-radius: 0;
    box-shadow: none;
  }
}
@media (prefers-reduced-motion: reduce) {
  html { scroll-behavior: auto; }
  .md-sidebar summary::before { transition: none; }
}
.md > :first-child { margin-top: 0; }
.md > :last-child { margin-bottom: 0; }
.md h1, .md h2, .md h3, .md h4, .md h5, .md h6 {
  margin: 32px 0 16px;
  font-weight: 600;
  font-feature-settings: "palt";
  line-height: 1.25;
  text-wrap: balance;
}
.md h1 { font-size: 2em; padding-bottom: 0.35em; border-bottom: 1px solid var(--md-border); }
.md h2 { font-size: 1.5em; }
.md h3 { font-size: 1.25em; }
.md h4 { font-size: 1em; }
.md h5 { font-size: 0.875em; }
.md h6 { font-size: 0.85em; color: var(--md-muted); }
.md p, .md ul, .md ol, .md blockquote, .md table { margin: 0 0 16px; }
.md a { color: var(--md-link); text-decoration: none; text-underline-offset: 0.15em; }
.md {
  overflow-wrap: anywhere;
  word-break: auto-phrase;
  line-break: strict;
}
.md a:hover { color: var(--md-link-hover); text-decoration: underline; }
.md ul, .md ol { padding-left: 2em; }
.md li + li { margin-top: 0.25em; }
.md blockquote {
  padding: 0.75em 1em;
  color: var(--md-muted);
  border-left: 3px solid var(--md-border-strong);
  border-radius: 0 var(--md-radius-md) var(--md-radius-md) 0;
  background: var(--md-muted-bg);
}
.md code {
  font: 0.85em ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-feature-settings: normal;
  background: var(--md-code-bg);
  padding: 0.2em 0.4em;
  border-radius: 6px;
}
.md pre {
  margin: 0 0 16px;
  background: var(--md-code-block-bg);
  color: var(--md-code-block-text);
  padding: 16px;
  overflow: auto;
  border-radius: 8px;
  line-height: 1.45;
  line-break: auto;
  overflow-wrap: normal;
  word-break: normal;
}
.md-code-block {
  position: relative;
  margin: 0 0 20px;
  overflow: hidden;
  border: 1px solid var(--md-code-block-border);
  border-radius: 9px;
  background: var(--md-code-block-bg);
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.18);
}
.md-code-block pre { margin: 0; }
.md-code-toolbar {
  display: flex;
  min-height: 38px;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 0 8px 0 14px;
  color: var(--md-code-block-muted);
  border-bottom: 1px solid var(--md-code-block-border);
  background: var(--md-code-block-surface);
  font: 600 0.75rem/1 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}
.md-code-copy {
  padding: 6px 8px;
  color: var(--md-code-block-muted);
  border: 0;
  border-radius: 5px;
  background: transparent;
  font: inherit;
  cursor: pointer;
}
.md-code-copy:hover { color: var(--md-code-block-text); background: rgba(240, 246, 252, 0.08); }
.md-code-copy:focus-visible { outline: 2px solid #58a6ff; outline-offset: 1px; }
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
.md img { max-width: 100%; height: auto; border-radius: var(--md-radius-md); }
.md p:has(> img:first-child + em:last-child) { text-align: center; }
.md p:has(> img:first-child) > em:last-child {
  display: block;
  margin-top: 6px;
  color: var(--md-faint);
  font-size: 0.8125rem;
  font-style: normal;
}
.md details:not(.md-metadata):not(.md-toc-mobile) {
  margin: 0 0 16px;
  padding: 0 16px 12px;
  border: 1px solid var(--md-border);
  border-radius: var(--md-radius-md);
  background: var(--md-surface);
}
.md details:not(.md-metadata):not(.md-toc-mobile) > summary {
  margin: 0 -16px -12px;
  padding: 10px 16px;
  color: var(--md-text);
  cursor: pointer;
  font-weight: 600;
}
.md details:not(.md-metadata):not(.md-toc-mobile)[open] > summary {
  margin-bottom: 12px;
  border-bottom: 1px solid var(--md-border);
}
.md details:not(.md-metadata):not(.md-toc-mobile) > summary:focus-visible {
  outline: 2px solid var(--md-link);
  outline-offset: 2px;
}
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
