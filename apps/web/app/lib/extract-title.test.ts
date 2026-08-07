import { describe, expect, test, vi } from 'vitest'
import {
  extractTitle,
  extractTitleFromBytes,
  extractTitleFromHtml,
  extractTitleFromMarkdown,
} from './extract-title'

describe('extractTitleFromHtml', () => {
  test.each([
    ['<title>Hello</title>', 'Hello'],
    ['<title>  Hello  </title>', 'Hello'],
    ['<TITLE>Upper</TITLE>', 'Upper'],
    [
      '<title>A &amp; B &lt; C &gt; D &quot;E&quot; &#39;F&#39;</title>',
      'A & B < C > D "E" \'F\'',
    ],
  ])('extracts %s', (html, expected) => {
    expect(extractTitleFromHtml(html)).toBe(expected)
  })

  test.each(['<title></title>', '<title>   </title>', '<h1>Hello</h1>'])(
    'returns null for %s',
    (html) => {
      expect(extractTitleFromHtml(html)).toBeNull()
    },
  )

  test('ignores title outside the 16KB scan window', () => {
    expect(
      extractTitleFromHtml(`${'x'.repeat(20 * 1024)}<title>Late</title>`),
    ).toBeNull()
  })
})

describe('extractTitleFromMarkdown', () => {
  test.each([
    ['# Hello', 'Hello'],
    ['---\ntitle: foo\n---\n# Heading', 'foo'],
    ['---\ntags: [a, b]\n---\n# Heading', 'Heading'],
    ['---\ntitle: "quoted"\n---', 'quoted'],
    ["---\ntitle: 'quoted'\n---", 'quoted'],
  ])('extracts %s', (markdown, expected) => {
    expect(extractTitleFromMarkdown(markdown)).toBe(expected)
  })

  test('skips headings inside code fences', () => {
    expect(
      extractTitleFromMarkdown('```\n# Not heading\n```\n\n## Real heading'),
    ).toBe('Real heading')
  })

  test('returns null without a frontmatter title or heading', () => {
    expect(extractTitleFromMarkdown('plain text')).toBeNull()
  })

  test('truncates title to 200 chars', () => {
    expect(extractTitleFromMarkdown(`# ${'a'.repeat(201)}`)).toBe(
      'a'.repeat(200),
    )
  })
})

describe('extractTitle', () => {
  test('dispatches by kind', () => {
    expect(extractTitle('<title>HTML</title>', 'html')).toBe('HTML')
    expect(extractTitle('# Markdown', 'md')).toBe('Markdown')
  })
})

describe('extractTitleFromBytes', () => {
  test('extracts from the leading scan window without decoding the whole file', () => {
    const prefix = new TextEncoder().encode('<title>Early</title>')
    const bytes = new Uint8Array(1024 * 1024)
    bytes.set(prefix, 0)
    bytes[900 * 1024] = 0xff

    expect(extractTitleFromBytes(bytes.buffer, 'html')).toBe('Early')
  })

  test('ignores a partial UTF-8 code point at the scan boundary', () => {
    const prefix = new TextEncoder().encode('<title>Early</title>')
    const bytes = new Uint8Array(20 * 1024).fill(0x20)
    bytes.set(prefix, 0)
    bytes[16 * 1024 - 1] = 0xe3
    bytes[16 * 1024] = 0x81
    bytes[16 * 1024 + 1] = 0x82

    expect(extractTitleFromBytes(bytes.buffer, 'html')).toBe('Early')
  })

  test('returns null for invalid UTF-8 inside the leading scan window', () => {
    const bytes = new Uint8Array([0xff, 0xfe, 0xfd])
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    expect(
      extractTitleFromBytes(bytes.buffer, 'html', {
        shareableId: 'share1',
        fileName: 'bad.html',
      }),
    ).toBeNull()
    expect(warnSpy).toHaveBeenCalledWith('extract_title_decode_failed', {
      shareable_id: 'share1',
      file_name: 'bad.html',
      err_name: 'TypeError',
    })
    warnSpy.mockRestore()
  })
})
