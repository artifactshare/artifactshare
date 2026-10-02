import { describe, expect, test } from 'vitest'
import {
  extractAnchorDocument,
  markAnchorSource,
} from '@artifactshare/viewer-kit/anchor-text'
import { renderMarkdownDocument } from './markdown-render'

describe('canonical source text', () => {
  test.each([
    [
      '<p>Spaced     text   with\n   line breaks inside it.</p>',
      'Spaced     text   with\n   line breaks inside it.',
    ],
    [
      '<p style="text-transform:uppercase">lowercase words shown upper</p>',
      'lowercase words shown upper',
    ],
    [
      '<p>Visible start <span style="display:none">HIDDEN</span> visible end.</p>',
      'Visible start HIDDEN visible end.',
    ],
    [
      '<ul><li>List item one</li><li>List item two</li></ul>',
      'List item oneList item two',
    ],
    [
      '<head><title>No</title></head><body>Yes<script>No</script><style>No</style><noscript>No</noscript><template>No</template><textarea>No</textarea><!--No--></body>',
      'Yes',
    ],
    ['<p>&copy;&NotEqualTilde;&#160;&#x1F600;&amp;</p>', '©≂̸\u00a0😀&'],
    ['<div data-comment-content><p>One</p><p>Two</p></div>Outside', 'OneTwo'],
    ['<table>Before<tr><td>Cell</table>After', 'BeforeCellAfter'],
    [
      '<p>A<mark class="ash-comment-highlight">B</mark><button class="ash-comment-highlight-badge">No</button><span data-comment-ui>No</span>C</p>',
      'ABC',
    ],
  ])('extracts HTML5 text from %s', (html, expected) => {
    expect(extractAnchorDocument(html).text).toBe(expected)
    expect(extractAnchorDocument(markAnchorSource(html).html).text).toBe(
      expected,
    )
  })
  test('nested blocks own contiguous runs and duplicate authored ids are not identities', () => {
    const doc = extractAnchorDocument(
      '<blockquote id="a">Before<p id="a">Inner</p>After</blockquote>',
    )
    expect(
      doc.blocks.map((b) => [doc.text.slice(b.start, b.end), b.id, b.unique]),
    ).toEqual([
      ['Before', 'a', false],
      ['Inner', 'a', false],
      ['After', 'a', false],
    ])
  })
  test('renderer controls and generated heading ids do not affect coordinates or identities', () => {
    const doc = extractAnchorDocument(
      renderMarkdownDocument('# Heading\n\n```mermaid\ngraph TD; A-->B\n```'),
    )
    expect(doc.text).toContain('graph TD; A-->B')
    expect(doc.text).not.toContain('Copy')
    expect(
      doc.blocks.find((b) => doc.text.slice(b.start, b.end) === 'Heading')?.id,
    ).toBeNull()
  })
})
