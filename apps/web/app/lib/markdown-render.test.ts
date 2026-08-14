import { describe, expect, test } from 'vitest'
import { VIOLATION_REPORTER_MARKER } from './csp-reporter'
import { renderMarkdownDocument } from './markdown-render'

describe('renderMarkdownDocument', () => {
  test('wraps output in a full HTML document', () => {
    const out = renderMarkdownDocument('# Hello')
    expect(out).toContain('<!doctype html>')
    expect(out).toContain('<body data-artifact-markdown>')
    expect(out).toContain('<article class="md" data-comment-content>')
    expect(out).toContain('<h1 id="hello">Hello</h1>')
  })

  test('applies prose typography without wrapping code or tables', () => {
    const out = renderMarkdownDocument('# Heading\n\nBody')

    expect(out).toContain('ui-sans-serif, system-ui')
    expect(out).toContain('font-feature-settings: "palt"')
    expect(out).toContain('text-wrap: balance')
    expect(out).toContain('line-break: strict')
    expect(out).toContain('font-feature-settings: normal')
    expect(out).toMatch(/\.md table \{[\s\S]*?overflow-wrap: normal;/)
    expect(out).toContain('--md-bg: #fbfaf8')
    expect(out).toContain('border-radius: 12px')
    expect(out).toMatch(/\.md-toc-desktop \{[\s\S]*?border-radius: 8px;/)
    expect(out).not.toMatch(/\.md-sidebar \{[^}]*border-right:/)
    expect(out).toMatch(/\.md-sidebar \{[^}]*padding-top: 32px;/)
    expect(out).toMatch(
      /@media \(max-width: 699px\) \{[\s\S]*?border-radius: 0;/,
    )
    expect(out).toContain('box-shadow: inset 2px 0')
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
    expect(out).toContain('<body data-artifact-markdown>')
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

  test('prioritizes contents and collapses secondary navigation', () => {
    const out = renderMarkdownDocument(
      '---\ntitle: Report\nauthor: Artifact Share\n---\n# Start\n## Next',
    )

    expect(out).toContain('<nav class="md-toc md-toc-desktop"')
    expect(out).toContain('<details class="md-toc-mobile">')
    expect(out).toContain('<nav class="md-toc" aria-label="Table of contents">')
    expect(out).toContain(
      '<details class="md-metadata" aria-label="Frontmatter"><summary>Frontmatter</summary>',
    )
    const navigation = out.slice(out.indexOf('<aside'), out.indexOf('</aside>'))
    expect(navigation.indexOf('md-toc-desktop')).toBeLessThan(
      navigation.indexOf('md-metadata'),
    )
    expect(out).not.toContain('<details class="md-metadata" open>')
    expect(out).not.toContain('<details class="md-toc-mobile" open>')
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
    expect(out).not.toContain('class="tm-code-frame"')
  })
})
