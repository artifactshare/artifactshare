import { readFileSync } from 'node:fs'
import { describe, expect, test } from 'vitest'
import { VIOLATION_REPORTER_MARKER } from './csp-reporter'
import { renderMarkdownDocument } from './markdown-render'

// Captured from the renderer before the outline viewer existed.
const legacyFixture = readFileSync(
  new URL('./__fixtures__/markdown-export-legacy.txt', import.meta.url),
  'utf8',
)

describe('renderMarkdownDocument', () => {
  test('wraps output in a full HTML document', () => {
    const out = renderMarkdownDocument('# Hello')
    expect(out).toContain('<!doctype html>')
    expect(out).toContain(
      '<body data-artifact-markdown data-md-outline-version="2">',
    )
    expect(out).toContain('<article class="md" data-comment-content>')
    expect(out).toContain('<h1 id="hello">Hello</h1>')
  })

  test('applies Japanese typesetting with OS fonts and monospace code', () => {
    const out = renderMarkdownDocument('# Heading\n\nBody')

    expect(out).toContain('ui-sans-serif, system-ui')
    expect(out).toContain('"Hiragino Sans"')
    expect(out).not.toContain('palt')
    expect(out).not.toContain('@font-face')
    expect(out).not.toMatch(/url\(/)
    expect(out).toContain('font-synthesis: none')
    expect(out).toMatch(
      /\.md \{[^}]*word-break: auto-phrase;[^}]*line-break: strict;/,
    )
    // Outline entries sit outside .md and need phrase-aware breaking too.
    expect(out).toMatch(
      /\.md-outline li > a \{[^}]*overflow-wrap: anywhere;[^}]*word-break: auto-phrase;[^}]*line-break: strict;/,
    )
    // A blockquote's last paragraph must not add trailing space inside it.
    expect(out).toContain('.md blockquote > :last-child { margin-bottom: 0; }')
    expect(out).toMatch(/\.md code \{[^}]*ui-monospace/)
    expect(out).toMatch(/\.md table \{[\s\S]*?overflow-wrap: normal;/)
    expect(out).toContain('--md-bg: #fbfaf8')
    // The right outline replaces the left column; narrower widths use the row.
    expect(out).toContain('grid-template-columns: minmax(0, 720px) 288px')
    expect(out).toMatch(
      /@media \(max-width: 1119px\) \{[\s\S]*?\.md-sidebar \{ display: none; \}[\s\S]*?\.md-position \{ display: block; \}/,
    )
    // The current entry changes color and tint only, never its weight.
    expect(out).toMatch(/li > a\[aria-current\] \{[^}]*color: var\(--md-link\)/)
    expect(out).not.toMatch(/\[aria-current\][^{]*\{[^}]*font-weight/)
    expect(out).toContain('stroke-dasharray 280ms')
    expect(out).toContain('color 160ms ease-out')
    expect(out).toMatch(
      /prefers-reduced-motion: reduce\) \{\s*\.md-outline-progress \{ transition: none; \}/,
    )
  })

  test('keeps the export rendering identical to its pre-outline output', () => {
    const source =
      '---\ntitle: 仕様\nlang: ja\n---\n# 概要\n\n本文です。\n\n## Same\n\n## Same\n\n## Same-2\n\n##### 細部\n\n```ts\nconst x = 1\n```\n'
    expect(
      renderMarkdownDocument(source, { logTiming: false, mode: 'export' }),
    ).toBe(legacyFixture)
  })

  test.each([
    [
      'suffix after repeated base',
      '## Same\n## Same\n## Same-2',
      ['same', 'same-2', 'same-2-2'],
    ],
    [
      'suffix before repeated base',
      '## Same-2\n## Same\n## Same',
      ['same-2', 'same', 'same-3'],
    ],
    [
      'fallback slugs',
      '## !!!\n## ???\n## Section-2',
      ['section', 'section-2', 'section-2-2'],
    ],
    ['NFKC-equivalent labels', '## ＡＢＣ\n## ABC', ['abc', 'abc-2']],
    [
      'collision-free labels',
      '## Alpha\n## Beta\n## Alpha',
      ['alpha', 'beta', 'alpha-2'],
    ],
  ])(
    'gives every heading a distinct ID and outline target: %s',
    (_name, source, ids) => {
      const out = renderMarkdownDocument(source, { logTiming: false })
      const article = out.slice(
        out.indexOf('<article'),
        out.indexOf('</article>'),
      )
      const articleIds = Array.from(
        article.matchAll(/<h2 id="([^"]+)"/g),
        (m) => m[1],
      )
      expect(articleIds).toEqual(ids)
      const allIds = Array.from(out.matchAll(/\sid="([^"]+)"/g), (m) => m[1])
      expect(new Set(allIds).size).toBe(allIds.length)
      const rail = out.slice(out.indexOf('<aside'), out.indexOf('</aside>'))
      expect(
        Array.from(rail.matchAll(/href="#([^"]+)"/g), (m) => m[1]),
      ).toEqual(ids)
    },
  )

  test('nests the outline by real heading levels without inventing parents', () => {
    const out = renderMarkdownDocument(
      '# Guide\n## Setup\n#### Detail\n## Usage\n### Options\n## <b>Tags</b> & "quotes"',
      { logTiming: false },
    )
    const rail = out.slice(out.indexOf('<aside'), out.indexOf('</aside>'))
    expect(rail).toContain(
      '<ol><li data-level="1" data-indent="0" data-overview><a href="#guide">Overview</a><ol>' +
        '<li data-level="2" data-indent="0"><a href="#setup">Setup</a><ol><li data-level="4" data-indent="1"><a href="#detail">Detail</a></li></ol></li>' +
        '<li data-level="2" data-indent="0"><a href="#usage">Usage</a><ol><li data-level="3" data-indent="1"><a href="#options">Options</a></li></ol></li>' +
        '<li data-level="2" data-indent="0"><a href="#tags-quotes">&lt;b&gt;Tags&lt;/b&gt; &amp; &quot;quotes&quot;</a></li>' +
        '</ol></li></ol>',
    )
    // The article keeps the real title; only the outline label changes.
    expect(out).toContain('<h1 id="guide">Guide</h1>')
    expect(rail).not.toMatch(/\d\.\s|counter/)
    expect(out).not.toContain('<input type="checkbox" data-md-outline-details>')
  })

  test.each([
    ['multiple H1s', '# One\n## A\n# Two', ['One', 'A', 'Two']],
    ['an H1 after the first heading', '## Intro\n# Title', ['Intro', 'Title']],
  ])('keeps real labels for %s', (_name, source, labels) => {
    const out = renderMarkdownDocument(source, { logTiming: false })
    const rail = out.slice(out.indexOf('<aside'), out.indexOf('</aside>'))
    expect(
      Array.from(rail.matchAll(/<a [^>]*>([^<]*)<\/a>/g), (m) => m[1]),
    ).toEqual(labels)
    expect(rail).not.toContain('data-overview')
  })

  test('hides H5 and H6 behind a finer-headings checkbox in both outline copies', () => {
    const out = renderMarkdownDocument('## A\n##### Fine\n###### Finer\n## B', {
      logTiming: false,
    })
    expect(
      out.match(
        /<input type="checkbox" data-md-outline-details>Show finer headings<\/label>/g,
      ),
    ).toHaveLength(2)
    expect(out).toContain(
      '<li data-level="5" data-indent="1" data-fine><a href="#fine">',
    )
    expect(out).toContain(
      '<li data-level="6" data-indent="2" data-fine><a href="#finer">',
    )
    expect(out).toContain(
      ':root:not(:has([data-md-outline-details]:checked)) .md-outline li[data-fine] { display: none; }',
    )
  })

  test('renders one contents row, a right outline and a closed panel', () => {
    const out = renderMarkdownDocument(
      '---\ntitle: Report\n---\n# Start\n## Next',
      {
        logTiming: false,
      },
    )
    expect(out.match(/class="md-position"/g)).toHaveLength(1)
    expect(out).toContain(
      '<div class="md-position" data-comment-ui><button type="button" class="md-position-button" aria-haspopup="dialog" aria-controls="md_outline_panel" aria-expanded="false"><span class="md-position-label">Contents</span><span class="md-position-current">Start</span>',
    )
    expect(out).toContain(
      '<aside class="md-sidebar" data-comment-ui><nav class="md-outline" data-md-outline="rail" aria-labelledby="md_outline_title"><div class="md-outline-header"><h2 id="md_outline_title">On this page</h2></div>',
    )
    expect(out).toContain(
      '<dialog id="md_outline_panel" class="md-outline-panel" aria-labelledby="md_outline_panel_title" data-comment-ui>',
    )
    expect(out).toContain('data-md-outline-close>Close</button>')
    expect(out).not.toContain(
      '<dialog id="md_outline_panel" class="md-outline-panel" open',
    )
    expect(out).toContain(
      '<div class="md-frontmatter" data-comment-ui><details class="md-metadata" aria-label="Frontmatter"><summary>Frontmatter</summary>',
    )
    expect(out.slice(out.indexOf('<body'))).not.toContain('aria-current')
  })

  test.each([
    ['without metadata', 'Plain text only.'],
    ['with metadata', '---\ntitle: Notes\n---\nPlain text only.'],
  ])(
    'a document without headings has no outline or contents row %s',
    (_name, source) => {
      const out = renderMarkdownDocument(source, { logTiming: false })
      const body = out.slice(out.indexOf('<body'))
      expect(body).not.toContain('md-position')
      expect(body).not.toContain('<aside')
      expect(body).not.toContain('<dialog')
      expect(out.includes('class="md-frontmatter"')).toBe(
        source.startsWith('---'),
      )
    },
  )

  test.each([
    ['kana', '# はじめに\n\nこれは本文です。', 'ja'],
    ['kanji', '# 概要\n\n仕様書', 'ja'],
    ['English', '# Intro\n\nPlain English.', 'en'],
    [
      'frontmatter English override',
      '---\nlang: en\n---\n# 概要\n\n本文です。',
      'en',
    ],
    [
      'quoted frontmatter Japanese override',
      '---\nlang: "ja-JP"\n---\n# Intro',
      'ja-JP',
    ],
    ['invalid frontmatter tag', '---\nlang: "><x\n---\n# Intro', 'en'],
  ])('decides lang and outline labels from %s', (_name, source, lang) => {
    const out = renderMarkdownDocument(source, { logTiming: false })
    expect(out).toContain(`<html lang="${lang}">`)
    const labels = lang.startsWith('ja')
      ? ['目次', 'このページ', '概要', '閉じる']
      : ['Contents', 'On this page', 'Overview', 'Close']
    expect(out).toContain(`<span class="md-position-label">${labels[0]}</span>`)
    expect(out).toContain(`<h2 id="md_outline_title">${labels[1]}</h2>`)
    expect(out).toContain(`>${labels[2]}</a>`)
    expect(out).toContain(`data-md-outline-close>${labels[3]}</button>`)
    expect(out).not.toContain('<x')
  })

  test('labels the finer-headings checkbox in Japanese', () => {
    const out = renderMarkdownDocument('## 章\n##### 細部', {
      logTiming: false,
    })
    expect(out).toContain('data-md-outline-details>細かい見出しも表示</label>')
  })

  test('renders GFM tables', () => {
    const md = `| a | b |\n|---|---|\n| 1 | 2 |`
    const out = renderMarkdownDocument(md)
    expect(out).toContain('<table>')
    expect(out).toContain('<td>1</td>')
  })

  test('renders fenced code blocks', () => {
    const out = renderMarkdownDocument('```\nconst x = 1\n```')
    expect(out).toContain('class="md-code-block" data-lang="plaintext"')
    expect(out).toContain('const x = 1')
  })

  test('escapes embedded HTML', () => {
    const out = renderMarkdownDocument('<div class="custom">x</div>')
    expect(out).toContain('&lt;div class=&quot;custom&quot;&gt;x&lt;/div&gt;')
    expect(out).not.toContain('<div class="custom">x</div>')
  })

  test('does not embed the CSP violation reporter inline', () => {
    // Reporter must be injected at response time, not bake-time.
    const out = renderMarkdownDocument('# Hello')
    expect(out).not.toContain(VIOLATION_REPORTER_MARKER)
  })

  test('renders the TanStack body with safe raw HTML, headings and autolinks', () => {
    const out = renderMarkdownDocument(
      '---\ntitle: Report\n---\n# Same\n# Same\n\nhttps://example.com/long\n\n<script>alert(1)</script>',
    )
    expect(out).toContain('<h1 id="same">')
    expect(out).toContain('<h1 id="same-2">')
    expect(out).toContain('<a href="https://example.com/long"')
    expect(out).toContain('aria-label="Frontmatter"')
    expect(out).toContain('href="#same-2"')
    expect(out).not.toContain('<script>alert(1)</script>')
  })

  test('renders a safe details block with Markdown content', () => {
    const out = renderMarkdownDocument(
      '<details>\n<summary>Why this approach?</summary>\n\nBody with **emphasis**.\n\n</details>',
    )

    expect(out).toContain('<details><summary>Why this approach?</summary>')
    expect(out).toContain('<p>Body with <strong>emphasis</strong>.</p>')
    expect(out).toContain('</details>')
  })

  test('limits details support to safe markup', () => {
    const out = renderMarkdownDocument(
      '<details onclick="alert(1)">\n<summary><img src=x onerror=alert(1)></summary>\n\nBody\n\n</details>',
    )

    expect(out).not.toContain('<details onclick=')
    expect(out).not.toContain('<img src=x')
    expect(out).not.toContain('<summary>')
  })

  test('does not close details on a tag inside a code fence', () => {
    const out = renderMarkdownDocument(
      '<details>\n<summary>Markup example</summary>\n\n```html\n</details>\n```\n\nStill inside.\n\n</details>',
    )

    expect(out).toContain('class="md-code-block" data-lang="html"')
    expect(out).toContain('class="th-token th-tag">details</span>')
    expect(out).toContain('<p>Still inside.</p></details>')
  })

  test('supports nested safe details blocks', () => {
    const out = renderMarkdownDocument(
      '<details>\n<summary>Outer</summary>\n\n<details>\n<summary>Inner</summary>\n\nNested body.\n\n</details>\n\nOuter body.\n\n</details>',
    )

    expect(out).toContain(
      '<details><summary>Outer</summary><details><summary>Inner</summary>',
    )
    expect(out).toContain('<p>Outer body.</p></details>')
  })

  test('handles many unclosed details blocks without rendering them', () => {
    const source = Array.from(
      { length: 2_000 },
      (_, index) => `<details>\n<summary>Unclosed ${index}</summary>`,
    ).join('\n')
    const out = renderMarkdownDocument(source)

    expect(out).not.toContain('<details><summary>')
    expect(out).toContain('&lt;details&gt;')
  })

  test('balances unsupported nested details without rendering them', () => {
    const out = renderMarkdownDocument(
      '<details>\n<summary>Outer</summary>\n\n<details class="unsupported">\nUnsupported body.\n</details>\n\nStill in outer.\n\n</details>',
    )

    expect(out).not.toContain('<details class="unsupported">')
    expect(out).toContain('&lt;details class=&quot;unsupported&quot;&gt;')
    expect(out).toContain('<p>Still in outer.</p></details>')
  })

  test('ignores closing tags inside raw HTML blocks', () => {
    const out = renderMarkdownDocument(
      '<details>\n<summary>Outer</summary>\n\n<!--\n</details>\n-->\n\n<pre>\n</details>\n</pre>\n\nStill in outer.\n\n</details>',
    )

    expect(out).toContain('&lt;!--\n&lt;/details&gt;\n--&gt;')
    expect(out).toContain('&lt;pre&gt;')
    expect(out).toContain('&lt;/pre&gt;')
    expect(out).toContain('<p>Still in outer.</p></details>')
  })

  test('ends a raw element region when it closes on its opening line', () => {
    const out = renderMarkdownDocument(
      '<details>\n<summary>Outer</summary>\n\n<pre>Example</pre>\n\n</details>',
    )

    expect(out).toContain('<details><summary>Outer</summary>')
    expect(out).toContain('&lt;pre&gt;Example&lt;/pre&gt;</details>')
  })

  test('ends every raw HTML block at a blank line like TanStack Markdown', () => {
    const out = renderMarkdownDocument(
      '<details>\n<summary>Outer</summary>\n\n<pre>\n\n<details>\n<summary>Inner</summary>\n\nInner body.\n\n</details>\n\n</details>',
    )

    expect(out.match(/<details>/g)).toHaveLength(2)
    expect(out).toContain('<summary>Inner</summary>')
    expect(out).toContain('<p>Inner body.</p></details></details>')
  })

  test('escapes disclosure trees beyond the supported nesting limit', () => {
    const opening = Array.from(
      { length: 17 },
      (_, index) => `<details>\n<summary>Level ${index + 1}</summary>`,
    ).join('\n\n')
    const closing = Array.from({ length: 17 }, () => '</details>').join('\n\n')
    const out = renderMarkdownDocument(`${opening}\nBody\n${closing}`)

    expect(out).not.toContain('<details>')
    expect(out).toContain('&lt;details&gt;')
    expect(out).toContain('&lt;summary&gt;Level 17&lt;/summary&gt;')
  })

  test('does not let tag-like paragraph text steal disclosure boundaries', () => {
    const out = renderMarkdownDocument(
      '<details>\n<summary>Outer</summary>\n\nVisible only when open.\n</details>\n\nStill in outer.\n\n</details>',
    )

    expect(out).toContain('<p>Visible only when open.\n&lt;/details&gt;</p>')
    expect(out).toContain('<p>Still in outer.</p></details>')
  })

  test('does not match disclosure openings embedded in paragraphs', () => {
    const out = renderMarkdownDocument(
      '<details>\n<summary>Outer</summary>\n\nProse about the syntax.\n<details>\n<summary>Not a block</summary>\n\n</details>\n\n</details>',
    )

    expect(out.match(/<details>/g)).toHaveLength(1)
    expect(out).toContain('&lt;details&gt;')
    expect(out).toContain('&lt;summary&gt;Not a block&lt;/summary&gt;')
  })

  test('does not render supported details inside unsupported details', () => {
    const out = renderMarkdownDocument(
      '<details class="unsupported">\n<summary>Outer</summary>\n\n<details>\n<summary>Inner</summary>\n\nNested body.\n\n</details>\n\n</details>',
    )

    expect(out).not.toContain('<details><summary>Inner</summary>')
    expect(out).toContain('&lt;details class=&quot;unsupported&quot;&gt;')
    expect(out).toContain('&lt;details&gt;')
  })

  test('embeds only a standalone YouTube URL through No-Cookie', () => {
    const out = renderMarkdownDocument('https://youtu.be/aqz-KE-bpKQ')
    expect(out).toContain(
      'src="https://www.youtube-nocookie.com/embed/aqz-KE-bpKQ"',
    )
    expect(out).toContain('sandbox="allow-scripts allow-same-origin"')
  })

  test('renders titled code in a dark code frame with a copy action', () => {
    const out = renderMarkdownDocument(
      '```ts title="app.ts"\nconst answer = 42\n```',
    )

    expect(out).toContain('class="md-code-block"')
    expect(out).toContain('class="md-code-label">app.ts</span>')
    expect(out).toContain('data-code-copy')
    expect(out).toContain('--md-code-block-bg: #0d1117')
  })

  test('renders untitled code without a language in the shared code frame', () => {
    const out = renderMarkdownDocument('```\nplain text\n```')

    expect(out).toContain('class="md-code-block" data-lang="plaintext"')
    expect(out).toContain('class="md-code-label">plaintext</span>')
    expect(out).toContain('data-code-copy')
    expect(out).toContain('plain text')
  })

  test('centers only image paragraphs that use the caption convention', () => {
    const out = renderMarkdownDocument(
      '![Diagram](https://example.com/diagram.png)\n*Caption*',
    )

    expect(out).toContain(
      '.md p:has(> img:first-child + em:last-child) { text-align: center; }',
    )
    expect(out).not.toContain(
      '.md p:has(> img:first-child) { text-align: center; }',
    )
  })

  test('uses the shared code frame for titled Mermaid blocks', () => {
    const out = renderMarkdownDocument(
      '```mermaid title="`Flow`.mmd"\ngraph LR\nA --> B\n```',
    )

    expect(out).toContain('class="md-code-label">`Flow`.mmd</span>')
    expect(out).toContain('<code class="language-mermaid">')
    expect(out).toContain(
      '.mermaid-diagram:focus-visible { outline: 2px solid #333; outline-offset: -2px; }',
    )
    expect(out).not.toContain('class="tm-code-frame"')
  })
})
