import { describe, expect, test } from 'vitest'
import { VIOLATION_REPORTER_MARKER } from './csp-reporter'
import { renderMarkdownDocument } from './markdown-render'

describe('renderMarkdownDocument', () => {
  test('wraps output in a full HTML document', () => {
    const out = renderMarkdownDocument('# Hello')
    expect(out).toContain('<!doctype html>')
    expect(out).toContain('<body data-markdown-renderer="marked">')
    expect(out).toContain('<article class="md" data-comment-content>')
    expect(out).toContain('<h1>Hello</h1>')
  })

  test('renders GFM tables', () => {
    const md = `| a | b |\n|---|---|\n| 1 | 2 |`
    const out = renderMarkdownDocument(md)
    expect(out).toContain('<table>')
    expect(out).toContain('<td>1</td>')
  })

  test('renders fenced code blocks', () => {
    const out = renderMarkdownDocument('```\nconst x = 1\n```')
    expect(out).toContain('<pre><code>')
    expect(out).toContain('const x = 1')
  })

  test('preserves embedded HTML (sandbox iframe is the security boundary)', () => {
    const out = renderMarkdownDocument('<div class="custom">x</div>')
    expect(out).toContain('<div class="custom">x</div>')
  })

  test('does not embed the CSP violation reporter inline', () => {
    // Reporter must be injected at response time, not bake-time.
    const out = renderMarkdownDocument('# Hello')
    expect(out).not.toContain(VIOLATION_REPORTER_MARKER)
  })

  test('renders the TanStack body with safe raw HTML, headings and autolinks', () => {
    const out = renderMarkdownDocument(
      '---\ntitle: Report\n---\n# Same\n# Same\n\nhttps://example.com/long\n\n<script>alert(1)</script>',
      'tanstack',
    )
    expect(out).toContain('<h1 id="same">')
    expect(out).toContain('<body data-markdown-renderer="tanstack">')
    expect(out).toContain('<h1 id="same-2">')
    expect(out).toContain('<a href="https://example.com/long"')
    expect(out).toContain('aria-label="Frontmatter"')
    expect(out).toContain('href="#same-2"')
    expect(out).not.toContain('<script>alert(1)</script>')
  })

  test('embeds only a standalone YouTube URL through No-Cookie', () => {
    const out = renderMarkdownDocument(
      'https://youtu.be/aqz-KE-bpKQ',
      'tanstack',
    )
    expect(out).toContain(
      'src="https://www.youtube-nocookie.com/embed/aqz-KE-bpKQ"',
    )
    expect(out).toContain('sandbox="allow-scripts allow-same-origin"')
  })
})
