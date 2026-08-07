import { renderMarkdown } from './markdown'

// No sanitization: output renders inside the sandbox iframe (opaque
// origin + allow-scripts only), which is the same trust boundary as
// raw HTML artifacts. The file's owner is also its author.
//
// The CSP violation reporter is injected by the response handler, not
// here — keeping render output bake-free so Workers Cache stays the
// canonical body store.
export function renderMarkdownDocument(source: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>${MD_STYLES}</style>
</head>
<body><article class="md">${renderMarkdown(source)}</article></body>
</html>`
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
body {
  background: var(--md-bg);
  color: var(--md-text);
  font: 16px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", "Hiragino Sans",
    "Hiragino Kaku Gothic ProN", "Yu Gothic", Meiryo, sans-serif;
  -webkit-font-smoothing: antialiased;
}
.md {
  max-width: 860px;
  margin: 0 auto;
  padding: 48px 32px 96px;
}
.md > :first-child { margin-top: 0; }
.md > :last-child { margin-bottom: 0; }
.md h1, .md h2, .md h3, .md h4, .md h5, .md h6 {
  margin: 32px 0 16px;
  font-weight: 600;
  line-height: 1.25;
}
.md h1 { font-size: 2em; padding-bottom: 0.3em; border-bottom: 1px solid var(--md-border); }
.md h2 { font-size: 1.5em; padding-bottom: 0.3em; border-bottom: 1px solid var(--md-border); }
.md h3 { font-size: 1.25em; }
.md h4 { font-size: 1em; }
.md h5 { font-size: 0.875em; }
.md h6 { font-size: 0.85em; color: var(--md-muted); }
.md p, .md ul, .md ol, .md blockquote, .md pre, .md table { margin: 0 0 16px; }
.md a { color: var(--md-link); text-decoration: none; }
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
}
.md th, .md td {
  padding: 6px 13px;
  border: 1px solid var(--md-border);
}
.md th { background: var(--md-code-bg); font-weight: 600; }
.md tr:nth-child(2n) td { background: var(--md-code-bg); }
.md img { max-width: 100%; height: auto; }
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
