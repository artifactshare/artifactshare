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
  /** `document` (default) renders the outline viewer for Markdown artifacts and
   * the CLI preview, including Markdown pages inside static sites. `export`
   * keeps the original script-free layout, English labels and heading IDs for
   * HTML exports, which carry no reporter script. */
  mode?: MarkdownRenderMode
}

export type MarkdownRenderMode = 'document' | 'export'

export function renderMarkdownDocument(
  source: string,
  options: MarkdownRenderOptions = {},
): string {
  const startedAt = performance.now()
  const markdown = splitFrontmatter(source)
  const document =
    options.mode === 'export'
      ? legacyDocument(markdown)
      : outlineDocument(markdown)
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

type SplitMarkdown = ReturnType<typeof splitFrontmatter>

function legacyDocument(markdown: SplitMarkdown) {
  const body = renderMarkdownBody(markdown.body)
  const navigation = legacyNavigation(markdown.metadata, body)
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>${MD_TOKEN_STYLES}${LEGACY_LAYOUT_STYLES}${MD_CONTENT_STYLES}${MARKDOWN_HIGHLIGHT_CSS}</style>
</head>
<body data-artifact-markdown><div class="md-shell">${navigation}<article class="md" data-comment-content>${body}</article></div></body>
</html>`
}

const OUTLINE_LABELS = {
  ja: {
    contents: '目次',
    onThisPage: 'このページ',
    overview: '概要',
    finer: '細かい見出しも表示',
    close: '閉じる',
  },
  en: {
    contents: 'Contents',
    onThisPage: 'On this page',
    overview: 'Overview',
    finer: 'Show finer headings',
    close: 'Close',
  },
}
type OutlineLabels = (typeof OUTLINE_LABELS)['en']

// Control IDs contain "_", which generated heading IDs never do, so they
// cannot collide with an article heading.
const PANEL_ID = 'md_outline_panel'

function outlineDocument(markdown: SplitMarkdown) {
  const body = renderMarkdownBody(markdown.body, { headingIds: 'unique' })
  const lang = documentLanguage(markdown.metadata, markdown.body)
  const labels = /^ja(?:-|$)/i.test(lang)
    ? OUTLINE_LABELS.ja
    : OUTLINE_LABELS.en
  const outline = renderOutline(extractHeadings(body), labels)
  return `<!doctype html>
<html lang="${escapeHtml(lang)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>${MD_TOKEN_STYLES}${MD_CONTENT_STYLES}${OUTLINE_LAYOUT_STYLES}${MARKDOWN_HIGHLIGHT_CSS}</style>
</head>
<body data-artifact-markdown data-md-outline-version="2">${outline.row}<div class="md-shell">${outline.sidebar}${frontmatterDisclosure(markdown.metadata, 'md-frontmatter')}<article class="md" data-comment-content>${body}</article></div>${outline.panel}</body>
</html>`
}

/**
 * A frontmatter `lang` wins; otherwise kana in the body means Japanese. Kanji
 * alone does not: Chinese text and English mentioning a kanji word stay `en`.
 */
function documentLanguage(metadata: string[], body: string) {
  for (const line of metadata) {
    const match = line.match(/^lang\s*:\s*(['"]?)([^'"]*)\1\s*$/)
    const tag = match?.[2]?.trim() ?? ''
    if (/^[A-Za-z]{1,8}(?:-[A-Za-z0-9]{1,8})*$/.test(tag)) return tag
  }
  return /[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(body) ? 'ja' : 'en'
}

interface OutlineHeading {
  level: number
  id: string
  label: string
}

function extractHeadings(body: string): OutlineHeading[] {
  return Array.from(
    body.matchAll(/<h([1-6]) id="([^"]+)">([\s\S]*?)<\/h\1>/g),
    ([, level, id, text]) => ({
      level: Number(level),
      id: id ?? '',
      label: plainText(text ?? ''),
    }),
  )
}

interface OutlineEntry extends OutlineHeading {
  indent: number
  overview: boolean
  fine: boolean
  children: OutlineEntry[]
}

function renderOutline(headings: OutlineHeading[], labels: OutlineLabels) {
  if (!headings.length) return { row: '', sidebar: '', panel: '' }
  // A sole H1 that opens the document is its title: it becomes the overview
  // entry and does not add an indentation step for the sections below it.
  const hasTitle =
    headings[0]?.level === 1 &&
    headings.filter((h) => h.level === 1).length === 1
  const sectionLevels = headings
    .filter((h) => !hasTitle || h.level !== 1)
    .map((h) => h.level)
  // H2–H4 by default; a document whose shallowest section is deeper still
  // shows that level, so the outline is never empty by default.
  const maxLevel = Math.min(
    6,
    Math.max(4, sectionLevels.length ? Math.min(...sectionLevels) : 2),
  )
  const roots: OutlineEntry[] = []
  const stack: OutlineEntry[] = []
  for (const heading of headings) {
    while (stack.length && stack.at(-1)!.level >= heading.level) stack.pop()
    const entry: OutlineEntry = {
      ...heading,
      indent: Math.min(
        5,
        Math.max(0, stack.length - (hasTitle && heading.level !== 1 ? 1 : 0)),
      ),
      overview: hasTitle && heading.level === 1,
      fine: heading.level > maxLevel,
      children: [],
    }
    ;(stack.at(-1)?.children ?? roots).push(entry)
    stack.push(entry)
  }
  const list = renderOutlineList(roots, labels)
  const toggle = headings.some((h) => h.level > maxLevel)
    ? `<label class="md-outline-detail"><input type="checkbox" data-md-outline-details>${escapeHtml(labels.finer)}</label>`
    : ''
  const rail =
    '<svg class="md-outline-rail" aria-hidden="true" hidden><path class="md-outline-track"/><path class="md-outline-progress" hidden/></svg>'
  const current = headings.find((h) => h.level <= maxLevel) ?? headings[0]!
  const row = `<div class="md-position" data-comment-ui data-anchor-ignore><button type="button" class="md-position-button" aria-haspopup="dialog" aria-controls="${PANEL_ID}" aria-expanded="false"><span class="md-position-label">${escapeHtml(labels.contents)}</span><span class="md-position-current">${current.label}</span><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg></button></div>`
  const sidebar = `<aside class="md-sidebar" data-comment-ui data-anchor-ignore><nav class="md-outline" data-md-outline="rail" aria-labelledby="md_outline_title"><div class="md-outline-header"><h2 id="md_outline_title">${escapeHtml(labels.onThisPage)}</h2>${toggle}</div>${list}${rail}</nav></aside>`
  const panel = `<dialog id="${PANEL_ID}" class="md-outline-panel" aria-labelledby="md_outline_panel_title" data-comment-ui data-anchor-ignore><div class="md-outline-sheet"><div class="md-outline-panel-head"><h2 id="md_outline_panel_title">${escapeHtml(labels.contents)}</h2><button type="button" class="md-outline-close" data-md-outline-close>${escapeHtml(labels.close)}</button></div>${toggle}<nav class="md-outline md-outline-list" data-md-outline="panel" aria-labelledby="md_outline_panel_title">${list}${rail}</nav></div></dialog>`
  return { row, sidebar, panel }
}

function renderOutlineList(
  entries: OutlineEntry[],
  labels: OutlineLabels,
): string {
  return `<ol>${entries
    .map(
      (entry) =>
        `<li data-level="${entry.level}" data-indent="${entry.indent}"${entry.fine ? ' data-fine' : ''}${entry.overview ? ' data-overview' : ''}><a href="#${escapeHtml(entry.id)}">${entry.overview ? escapeHtml(labels.overview) : entry.label}</a>${entry.children.length ? renderOutlineList(entry.children, labels) : ''}</li>`,
    )
    .join('')}</ol>`
}

function frontmatterDisclosure(metadata: string[], wrapper?: string) {
  if (!metadata.length) return ''
  const details = `<details class="md-metadata" aria-label="Frontmatter"><summary>Frontmatter</summary><dl>${metadata
    .map((line) => {
      const separator = line.indexOf(':')
      const key = separator < 0 ? line : line.slice(0, separator)
      const value = separator < 0 ? '' : line.slice(separator + 1).trim()
      return `<div><dt>${escapeHtml(key)}</dt><dd>${escapeHtml(value)}</dd></div>`
    })
    .join('')}</dl></details>`
  return wrapper
    ? `<div class="${wrapper}" data-comment-ui>${details}</div>`
    : details
}

function legacyNavigation(metadata: string[], body: string) {
  const headings = Array.from(
    body.matchAll(/<h([1-6]) id="([^"]+)">([\s\S]*?)<\/h\1>/g),
  )
  if (metadata.length === 0 && headings.length === 0) return ''
  const frontmatter = frontmatterDisclosure(metadata)
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
// The legacy stylesheet is MD_TOKEN_STYLES + LEGACY_LAYOUT_STYLES +
// MD_CONTENT_STYLES, byte for byte as before the outline layout existed.
const MD_TOKEN_STYLES = `
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
`
const LEGACY_LAYOUT_STYLES = `* { box-sizing: border-box; }
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
`
const MD_CONTENT_STYLES = `.md p, .md ul, .md ol, .md blockquote, .md table { margin: 0 0 16px; }
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
.mermaid-diagram { margin: 0 0 16px; padding: 16px; overflow: auto; background: #fff; color: #333; text-align: center; }
.mermaid-diagram:focus-visible { outline: 2px solid #333; outline-offset: -2px; }
.md-code-block .mermaid-diagram { margin: 0; }
.mermaid-diagram svg { display: block; max-width: none; height: auto; margin: 0 auto; }
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

// Outline viewer layout: right outline at 1120px and wider, one compact
// contents row with a modal panel below. OS fonts only; no web font.
const OUTLINE_LAYOUT_STYLES = `* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; }
html { scroll-behavior: auto; }
.md [id] { scroll-margin-top: 72px; }
html:has(.md-outline-panel[open]) { overflow: hidden; scrollbar-gutter: stable; }
body {
  background: var(--md-bg);
  color: var(--md-text);
  font: 400 18px/1.85 ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont,
    "Segoe UI", "Hiragino Sans", "Hiragino Kaku Gothic ProN", "Noto Sans JP",
    "Yu Gothic UI", Meiryo, sans-serif, "Apple Color Emoji", "Segoe UI Emoji";
  font-synthesis: none;
  line-break: strict;
  -webkit-font-smoothing: antialiased;
}
.md-shell { max-width: 1112px; margin: 0 auto; padding: 40px 28px 80px; }
.md-shell:not(:has(> .md-sidebar)) { max-width: 776px; }
.md-shell:has(> .md-sidebar) {
  display: grid;
  grid-template-columns: minmax(0, 720px) 288px;
  grid-template-rows: auto 1fr;
  column-gap: 48px;
}
.md { grid-column: 1; grid-row: 2; width: 100%; max-width: 720px; min-width: 0; margin: 0; }
.md > :first-child { margin-top: 0; }
.md > :last-child { margin-bottom: 0; }
.md blockquote > :last-child { margin-bottom: 0; }
.md h1, .md h2, .md h3, .md h4, .md h5, .md h6 {
  margin: 28px 0 12px;
  font-weight: 700;
  font-feature-settings: normal;
  letter-spacing: normal;
  line-height: 1.6;
  text-wrap: balance;
}
.md h1 { font-size: 30px; margin-bottom: 24px; }
.md h2 { font-size: 24px; margin-top: 44px; }
.md h3 { font-size: 21px; margin-top: 34px; }
.md h4 { font-size: 19px; }
.md h5 { font-size: 17px; }
.md h6 { font-size: 16px; color: var(--md-muted); }
.md p, .md ul, .md ol { margin-bottom: 24px; }
.md strong, .md b, .md th { font-weight: 700; }
.md :is(h1, h2, h3, h4, h5, h6)[tabindex="-1"]:focus { outline: none; }
.md-frontmatter { grid-column: 1; grid-row: 1; margin: 0 0 24px; color: var(--md-muted); font-size: 14px; line-height: 1.6; }
.md-frontmatter summary {
  padding: 8px 12px;
  border: 1px solid var(--md-border);
  border-radius: var(--md-radius-md);
  background: var(--md-surface);
  color: var(--md-text);
  cursor: pointer;
  font-weight: 700;
}
.md-frontmatter details[open] > summary { border-radius: var(--md-radius-md) var(--md-radius-md) 0 0; }
.md-frontmatter summary:focus-visible { outline: 2px solid var(--md-link); outline-offset: 2px; }
.md-frontmatter dl {
  margin: 0;
  padding: 10px 12px;
  border: 1px solid var(--md-border);
  border-top: 0;
  border-radius: 0 0 var(--md-radius-md) var(--md-radius-md);
  background: var(--md-muted-bg);
}
.md-frontmatter dl div { display: grid; grid-template-columns: minmax(4.5rem,auto) minmax(0,1fr); gap: 12px; padding: 4px 0; }
.md-frontmatter dt { color: var(--md-faint); font-size: 12px; font-weight: 700; }
.md-frontmatter dd { margin: 0; color: var(--md-text); overflow-wrap: anywhere; }
.md-sidebar {
  grid-column: 2;
  grid-row: 1 / 3;
  position: sticky;
  top: 24px;
  align-self: start;
  max-height: calc(100dvh - 48px);
  overflow: auto;
  color: var(--md-muted);
  font-size: 13px;
  overscroll-behavior: contain;
  scrollbar-gutter: stable;
  scrollbar-color: var(--md-border) transparent;
}
.md-outline { position: relative; }
.md-sidebar .md-outline { padding: 0 8px 0 0; }
.md-outline-header { position: sticky; top: 0; z-index: 3; padding: 0 0 10px; background: var(--md-bg); }
.md-outline-header h2 { margin: 0; color: var(--md-text); font-size: 14px; line-height: 1.7; font-weight: 700; }
.md-outline-detail {
  display: flex;
  align-items: center;
  gap: 6px;
  min-height: 28px;
  color: var(--md-muted);
  font-size: 12px;
  line-height: 1.6;
  cursor: pointer;
}
.md-outline-detail input { flex-shrink: 0; margin: 0; accent-color: var(--md-link); }
.md-outline ol { margin: 0; padding: 0; list-style: none; }
.md-outline li { margin: 0; padding: 0; }
.md-outline li[data-level="2"] { margin-block-start: 8px; }
.md-outline li > a {
  display: block;
  padding: 4px 6px 4px 20px;
  border-radius: 4px;
  color: var(--md-muted);
  background: transparent;
  font-size: 13px;
  line-height: 1.6;
  font-weight: 400;
  text-decoration: none;
  overflow-wrap: anywhere;
  word-break: auto-phrase;
  line-break: strict;
  transition: color 160ms ease-out, background-color 160ms ease-out;
}
.md-outline li[data-indent="1"] > a { padding-left: 32px; }
.md-outline li[data-indent="2"] > a { padding-left: 44px; }
.md-outline li[data-indent="3"] > a { padding-left: 56px; }
.md-outline li[data-indent="4"] > a { padding-left: 68px; }
.md-outline li[data-indent="5"] > a { padding-left: 80px; }
.md-outline li > a:hover { color: var(--md-text); background: var(--md-accent-bg); }
.md-outline li > a[aria-current] { color: var(--md-link); background: color-mix(in srgb, var(--md-link) 3%, transparent); }
.md-outline li[data-level="2"] > a, .md-outline li[data-level="1"]:not([data-overview]) > a { color: var(--md-text); font-weight: 700; }
.md-outline li[data-level="2"] > a[aria-current], .md-outline li[data-level="1"] > a[aria-current] { color: var(--md-link); }
:root:not(:has([data-md-outline-details]:checked)) .md-outline li[data-fine] { display: none; }
.md-outline-rail {
  position: absolute;
  top: 0;
  left: 0;
  z-index: 1;
  width: 100%;
  overflow: visible;
  fill: none;
  pointer-events: none;
}
.md-outline-track { stroke: var(--md-border-strong); stroke-opacity: 0.5; stroke-width: 1; stroke-linecap: round; }
.md-outline-progress {
  stroke: var(--md-link);
  stroke-width: 2;
  stroke-linecap: round;
  transition: stroke-dasharray 280ms cubic-bezier(0.16, 1, 0.3, 1), stroke-dashoffset 280ms cubic-bezier(0.16, 1, 0.3, 1);
}
.md-outline-rail[hidden], .md-outline-progress[hidden] { display: none; }
.md-position {
  display: none;
  position: sticky;
  top: 0;
  z-index: 10;
  border-bottom: 1px solid var(--md-border);
  background: var(--md-bg);
}
.md-position-button {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  min-height: 44px;
  padding: 8px 20px;
  border: 0;
  background: transparent;
  color: var(--md-text);
  font: inherit;
  font-size: 13px;
  line-height: 1.7;
  text-align: left;
  cursor: pointer;
}
.md-position-button:hover { background: var(--md-accent-bg); }
.md-position-label { flex-shrink: 0; color: var(--md-link); }
.md-position-current { flex: 1; min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.md-position-button svg { flex-shrink: 0; width: 16px; height: 16px; }
.md-outline-panel {
  position: fixed;
  inset: 0 0 0 auto;
  width: 380px;
  max-width: 100%;
  height: 100dvh;
  max-height: 100dvh;
  margin: 0;
  padding: 0;
  border: 0;
  border-left: 1px solid var(--md-border);
  background: var(--md-bg);
  color: var(--md-text);
  overflow: hidden;
}
.md-outline-panel::backdrop { background: rgba(20, 22, 24, 0.26); }
.md-outline-sheet { display: flex; flex-direction: column; height: 100%; }
.md-outline-panel-head {
  display: flex;
  flex-shrink: 0;
  align-items: center;
  justify-content: space-between;
  min-height: 56px;
  padding: 20px 20px 6px;
  border-bottom: 1px solid var(--md-border);
}
.md-outline-panel-head h2 { margin: 0; font-size: 16px; line-height: 1.7; font-weight: 700; }
.md-outline-close {
  min-width: 44px;
  min-height: 44px;
  border: 0;
  background: transparent;
  color: inherit;
  font: inherit;
  font-size: 14px;
  cursor: pointer;
}
.md-outline-sheet > .md-outline-detail { flex-shrink: 0; min-height: 44px; padding: 0 20px; }
.md-outline-list {
  flex: 1;
  min-height: 0;
  overflow: auto;
  overscroll-behavior: contain;
  padding: 16px 20px calc(24px + env(safe-area-inset-bottom));
  scrollbar-color: var(--md-border) transparent;
}
.md-outline-list > .md-outline-rail { left: 20px; width: calc(100% - 20px); }
.md-outline-list li > a { min-height: 44px; padding-top: 6px; padding-bottom: 6px; font-size: 14px; line-height: 1.65; }
.md-outline-list li[data-level="2"] > a, .md-outline-list li[data-level="1"]:not([data-overview]) > a { font-size: 15px; }
.md-outline a:focus-visible, .md-outline-detail input:focus-visible, .md-position-button:focus-visible, .md-outline-panel button:focus-visible {
  outline: 2px solid var(--md-link);
  outline-offset: -2px;
}
@media (max-width: 1119px) {
  .md-shell, .md-shell:has(> .md-sidebar) { display: block; max-width: 760px; padding: 28px 20px 64px; }
  /* Without the outline controller (no reporter), the list itself stays
     usable at the top of the document with plain fragment links. */
  .md-sidebar { position: static; max-height: none; overflow: visible; margin: 0 0 24px; }
  .md-outline-header { position: static; }
  :root[data-md-outline-ready] .md-sidebar { display: none; }
  :root[data-md-outline-ready] .md-position { display: block; }
  .md h1 { font-size: 28px; }
  .md h2 { font-size: 23px; }
  .md-outline-panel { width: 100%; border: 0; }
}
@media (pointer: coarse) {
  .md-sidebar .md-outline li > a { min-height: 44px; padding-top: 8px; padding-bottom: 8px; }
  .md-outline-detail { min-height: 44px; }
}
@media (prefers-reduced-motion: reduce) {
  .md-outline-progress { transition: none; }
  .md-outline li > a { transition: color 80ms linear, background-color 80ms linear; }
}
`
