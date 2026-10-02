import { createRequire } from 'node:module'
import { describe, expect, test } from 'vitest'
import {
  extractAnchorDocument,
  markAnchorSource,
} from '@artifactshare/viewer-kit/anchor-text'
import { renderMarkdownDocument } from './markdown-render'

const { parse } = createRequire(
  import.meta.resolve('@artifactshare/viewer-kit/anchor-text'),
)('parse5') as { parse: (source: string) => ParsedNode }
interface ParsedNode {
  nodeName: string
  tagName?: string
  data?: string
  value?: string
  childNodes?: ParsedNode[]
}

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
  test('source splicing preserves legacy doctypes and authored markup byte for byte', () => {
    const source =
      '<!DOCTYPE HTML PUBLIC "-//W3C//DTD HTML 4.01 Transitional//EN" "http://www.w3.org/TR/html4/loose.dtd"><HTML><HEAD></HEAD><BODY><P class=hello>&copy; &#x41;</P></BODY></HTML>'
    const marked = markAnchorSource(source)
    expect(
      marked.html
        .replace(marked.manifest, '')
        .replace(/<!--ash-source(?:-end)?:\d+-->/g, ''),
    ).toBe(source)
  })
  test.each(['xmp', 'iframe', 'noembed', 'noframes', 'plaintext'])(
    'raw-text %s never receives literal markers',
    (tag) => {
      const source = `<p>Before</p><${tag}>Raw fallback</${tag}><p>After</p>`
      const marked = markAnchorSource(source)
      expect(marked.html).toContain(`<${tag}>Raw fallback</${tag}>`)
      expect(extractAnchorDocument(marked.html).text).toBe(
        tag === 'plaintext' ? 'Before' : 'BeforeAfter',
      )
    },
  )
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

test.each([
  '<!doctype html>\n<html><head></head><body><p>Hello world</p>\n</body>\n</html>\n',
  '<html><body><p>Hello world</p></body>\n</html>',
  '<html><body><p>Hello world</p></body>Tail</html>',
  '<table>Before<tr><td>Hello world</td></tr>After</table>',
  '<table>Before<b><tr><td>Cell</td></tr>After</table>',
  '<p>Intro</p>\n<table>Before<b><tr><td>Cell</td></tr>After</table>',
  'Inline<table>Before<div>Middle</div><tr><td>Cell</td></tr>After</table>',
  '<table>Before<b><tr><td>Cell',
  '<table>Before<b><i>Middle<tr><td>Cell</td></tr>After</table>End',
  '<table><b><tr><td>Cell</td></tr>Fostered</table>After',
  '<table><b><i>Before<tr><td>Cell</td></tr>After</table>End',
  'Before<p>Hello world</p>',
])('source regions survive HTML5 repairs: %s', (source) => {
  const marked = markAnchorSource(source)
  expect(extractAnchorDocument(marked.html).text).toBe(
    extractAnchorDocument(source).text,
  )
  const expected = JSON.parse(
    />(.*)<\/script>/.exec(marked.manifest)![1],
  ) as string[]
  const values: string[] = []
  const active: number[] = []
  let nextRegion = 0,
    lastTextRegion = -1
  function visit(node: ParsedNode) {
    if ('tagName' in node && node.tagName === 'script') return
    if (node.nodeName === '#comment' && typeof node.data === 'string') {
      const start = /^ash-source:(\d+)$/.exec(node.data)
      const end = /^ash-source-end:(\d+)$/.exec(node.data)
      if (start) {
        const id = Number(start[1])
        expect(id).toBe(nextRegion++)
        active.push(id)
        values[id] = ''
      }
      if (end) expect(active.pop()).toBe(Number(end[1]))
    } else if (typeof node.value === 'string' && active.length) {
      const id = active.at(-1)!
      expect(id).toBeGreaterThanOrEqual(lastTextRegion)
      lastTextRegion = id
      values[id] += node.value
    }
    node.childNodes?.forEach(visit)
  }
  visit(parse(marked.html))
  expect(active).toEqual([])
  expect(values).toEqual(expected)
})
