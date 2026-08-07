import { describe, expect, test } from 'vitest'
import { MAX_EXCERPT_CHARS, previewExcerpt } from './preview-excerpt'

describe('previewExcerpt markdown', () => {
  test('strips headings, links, code fences, lists, and emphasis', () => {
    const source = `# Hello World

This is **bold** and _italic_ text with a [link text](https://example.com).

\`\`\`js
const x = 1
\`\`\`

- item one
- item two

More prose here for the excerpt.`

    expect(previewExcerpt(source, 'markdown')).toBe(
      'Hello World This is bold and italic text with a link text. item one item two More prose here for the excerpt.',
    )
  })
})

describe('previewExcerpt html', () => {
  test('removes script, style, and tags and decodes entities', () => {
    const source = `<!doctype html>
<html>
<head>
<style>body { color: red; }</style>
<script>alert('x')</script>
<title></title>
</head>
<body>
<p>Hello &amp; welcome to <strong>Artifact Share</strong>.</p>
<p>Second paragraph with &quot;quotes&quot; and &#39;apostrophes&#39;.</p>
</body>
</html>`

    expect(previewExcerpt(source, 'html')).toBe(
      'Hello & welcome to Artifact Share. Second paragraph with "quotes" and \'apostrophes\'.',
    )
  })

  test('returns null for empty HTML shells', () => {
    expect(
      previewExcerpt('<!doctype html><div id="root"></div>', 'html'),
    ).toBeNull()
  })

  test('removes HTML comments before extracting text', () => {
    const source =
      '<!-- internal note -->' +
      '<p>Visible paragraph with enough text for the excerpt.</p>'
    expect(previewExcerpt(source, 'html')).toBe(
      'Visible paragraph with enough text for the excerpt.',
    )
  })
})

describe('previewExcerpt truncation', () => {
  test('truncates beyond MAX_EXCERPT_CHARS with an ellipsis', () => {
    const source = `# ${'word '.repeat(40)}`
    const result = previewExcerpt(source, 'markdown')
    expect(result).not.toBeNull()
    expect(result!.length).toBeLessThanOrEqual(MAX_EXCERPT_CHARS + 1)
    expect(result!.endsWith('…')).toBe(true)
  })

  test('does not append ellipsis when text fits', () => {
    const source = 'Short but long enough plain text.'
    expect(previewExcerpt(source, 'markdown')).toBe(source)
  })
})

describe('previewExcerpt source scan limit', () => {
  test('handles inputs larger than 64KB without throwing', () => {
    const prefix = '# ' + 'word '.repeat(30)
    const huge = prefix + 'x'.repeat(100_000)
    const result = previewExcerpt(huge, 'markdown')
    expect(result).not.toBeNull()
    expect(result!.length).toBeLessThanOrEqual(MAX_EXCERPT_CHARS + 1)
  })
})

describe('previewExcerpt japanese', () => {
  test('preserves multibyte text without corrupting surrogate pairs at the cut', () => {
    const source =
      'これは日本語の本文です。Slackプレビュー用の抜粋テストを行います。絵文字🎉も含めて正しく切り詰められることを確認します。' +
      'あ'.repeat(100)

    const result = previewExcerpt(source, 'markdown')
    expect(result).not.toBeNull()
    expect(result!.endsWith('…')).toBe(true)
    expect(result!.slice(0, -1)).not.toMatch(/[\uD800-\uDBFF]$/)
    expect(result!.includes('これは日本語')).toBe(true)
  })
})
