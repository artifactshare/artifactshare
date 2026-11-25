import { describe, expect, test } from 'vitest'
import { previewExcerpt } from './preview-excerpt'

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
  test('keeps 140 characters and cuts the 141st with an ellipsis', () => {
    const fits = 'abcdefghij'.repeat(14)
    expect(previewExcerpt(fits, 'markdown')).toBe(fits)
    expect(previewExcerpt(`${fits}k`, 'markdown')).toBe(`${fits}…`)
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
    expect(result!.length).toBeLessThanOrEqual(141)
  })
})

describe('previewExcerpt japanese', () => {
  test('drops a surrogate pair that the cut would split', () => {
    const before = 'あ'.repeat(139)
    expect(previewExcerpt(`${before}🎉いいい`, 'markdown')).toBe(`${before}…`)
  })
})
