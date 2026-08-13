import { describe, expect, test } from 'vitest'

import {
  MARKDOWN_LAB_SOURCE,
  loader,
  renderMarked,
  renderTanStack,
  splitFrontmatter,
} from './poc.markdown.$renderer'
import { enhanceHtml } from './markdown-lab.server'

describe('Markdown renderer lab', () => {
  test('passes identical post-frontmatter source to both renderers', () => {
    const { metadataLines, renderSource } =
      splitFrontmatter(MARKDOWN_LAB_SOURCE)
    const marked = renderMarked(renderSource)
    const tanstack = renderTanStack(renderSource)

    expect(metadataLines).toContain('title: Markdown renderer lab')
    expect(marked.headings.map((heading) => heading.id)).toEqual(
      tanstack.headings.map((heading) => heading.id),
    )
    expect(marked.headings.map((heading) => heading.id)).toContain(
      '同じ見出し-2',
    )
  })

  test.each([renderMarked, renderTanStack])(
    'keeps raw HTML visible but inactive',
    (render) => {
      const result = render(
        '<div onclick="alert(1)">visible</div>\n\n<iframe src="https://example.com"></iframe>',
      )
      expect(result.html).toContain('&lt;div')
      expect(result.html).toContain('&lt;iframe')
      expect(result.html).not.toContain('<iframe')
      expect(result.html).not.toContain('<div onclick=')
    },
  )

  test('returns 404 for an unknown renderer', async () => {
    await expect(
      loader({ params: { renderer: 'unknown' } }),
    ).rejects.toMatchObject({ status: 404 })
  })

  test('uses the same source hash on both routes', async () => {
    const [marked, tanstack] = await Promise.all([
      loader({ params: { renderer: 'marked' } }),
      loader({ params: { renderer: 'tanstack' } }),
    ])
    expect(marked.sourceHash).toBe(tanstack.sourceHash)
    expect(marked.renderSource).toBe(tanstack.renderSource)
    expect(marked.document).toContain('Raw HTML stays visible as source.')
    expect(marked.articleHtml).toContain('class="shiki github-light"')
    expect(tanstack.articleHtml).toContain('class="shiki github-light"')
    expect(marked.youtubeVideoId).toBe('aqz-KE-bpKQ')
    expect(tanstack.youtubeVideoId).toBe('aqz-KE-bpKQ')
    expect(marked.articleHtml).toContain('language-mermaid')
    expect(tanstack.articleHtml).toContain('language-mermaid')
  })

  test('does not convert arbitrary YouTube-like text into HTML', async () => {
    expect(await enhanceHtml('<p>youtube:not/a/video</p>')).toBe(
      '<p>youtube:not/a/video</p>',
    )
  })

  test('reports representative comment-anchor compatibility', () => {
    const { renderSource } = splitFrontmatter(MARKDOWN_LAB_SOURCE)
    const markedText = searchText(renderMarked(renderSource).html)
    const tanstackText = searchText(renderTanStack(renderSource).html)
    const quotes = [
      'コメント位置の比較対象になる文章をここに置きます。',
      'abcdefghijklmnopqrstuvwxyz',
      'return value.toUpperCase()',
    ]
    const results = quotes.map((quote) => {
      const markedOffset = markedText.indexOf(quote)
      const tanstackOffset = tanstackText.indexOf(quote)
      if (markedOffset < 0 || tanstackOffset < 0) return 'not-found'
      return markedOffset === tanstackOffset ? 'exact' : 'shifted-relocatable'
    })

    expect(results).not.toContain('not-found')
  })
})

function searchText(html: string) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, '')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
    .replaceAll('&amp;', '&')
}
