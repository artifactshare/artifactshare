import { describe, expect, test, vi } from 'vitest'
import { Window } from 'happy-dom'

import {
  MARKDOWN_LAB_SOURCE,
  loader,
  renderMarked,
  renderTanStack,
  splitFrontmatter,
} from './poc.markdown.$renderer'
import { enableMarkdownFragmentNavigation } from '~/lib/markdown-fragment-navigation.client'
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

  test('covers the selected GitHub-compatible Markdown basics', async () => {
    const source = `# Compatibility

https://example.com/docs?a=1&b=2

| Feature | Result |
| --- | --- |
| Table | visible |

\`\`\`javascript
const compatible = true
\`\`\`

\`\`\`mermaid
flowchart LR
  A --> B
\`\`\``
    const marked = renderMarked(source)
    const tanstack = renderTanStack(source)
    const [markedHtml, tanstackHtml] = await Promise.all([
      enhanceHtml(marked.html, 'marked'),
      enhanceHtml(tanstack.html, 'tanstack'),
    ])

    expect(marked.headings).toEqual(tanstack.headings)
    expect(markedHtml).toContain('<a href="https://example.com/docs?a=1&b=2">')
    expect(tanstackHtml).toContain(
      '<a href="https://example.com/docs?a=1&amp;b=2">',
    )
    expect(markedHtml).toContain('<table>')
    expect(tanstackHtml).toContain('<table>')
    expect(tanstackHtml).toContain('data-language="js"')
    expect(markedHtml).toContain('language-mermaid')
    expect(tanstackHtml).toContain('language-mermaid')
  })

  test('keeps heading IDs aligned when headings contain inline markup', () => {
    for (const source of [
      '## See [the docs](https://example.com) and `code`',
      '## ![](image.png)',
      '## Click <a href="https://example.com">here</a> now',
      '> ## Nested heading',
    ]) {
      expect(renderMarked(source).headings).toEqual(
        renderTanStack(source).headings,
      )
    }
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
    expect(tanstack.articleHtml).toContain('class="th-code th-code--ts"')
    expect(tanstack.articleHtml).toContain(
      '<a href="https://example.com/a/very/long/path/',
    )
    expect(tanstack.document).toContain('--th-background')
    expect(tanstack.document).toContain('word-break:auto-phrase')
    expect(tanstack.document).toContain('overflow-wrap:anywhere')
    expect(tanstack.document).toContain('overflow-x:auto')
    expect(marked.youtubeVideoId).toBe('aqz-KE-bpKQ')
    expect(tanstack.youtubeVideoId).toBe('aqz-KE-bpKQ')
    expect(marked.articleHtml).toContain('language-mermaid')
    expect(tanstack.articleHtml).toContain('language-mermaid')
  })

  test('keeps fragment links inside the Markdown frame', () => {
    const window = new Window()
    const document = window.document
    document.body.innerHTML =
      '<iframe title="Markdown"><a href="#target">Target</a><h2 id="target">Heading</h2></iframe>'
    const frame = document.querySelector(
      'iframe',
    ) as unknown as HTMLIFrameElement
    const frameDocument = frame.contentDocument!
    frameDocument.body.innerHTML =
      '<nav><a href="#同じ見出し"><span>Target</span></a></nav><article><h2 id="同じ見出し">Heading</h2></article>'
    const target = frameDocument.getElementById('同じ見出し')!
    const scrollIntoView = vi.fn()
    target.scrollIntoView = scrollIntoView
    enableMarkdownFragmentNavigation(frame)

    const linkChild = frameDocument.querySelector('span')!
    const event = new frameDocument.defaultView!.MouseEvent('click', {
      bubbles: true,
      cancelable: true,
    })
    linkChild.dispatchEvent(event)

    expect(event.defaultPrevented).toBe(true)
    expect(scrollIntoView).toHaveBeenCalledWith({
      behavior: 'smooth',
      block: 'start',
    })
    expect(frameDocument.querySelector('a')?.getAttribute('aria-current')).toBe(
      'location',
    )
    window.close()
  })

  test('does not convert arbitrary YouTube-like text into HTML', async () => {
    expect(await enhanceHtml('<p>youtube:not/a/video</p>', 'tanstack')).toBe(
      '<p>youtube:not/a/video</p>',
    )
  })

  test('highlights registered aliases and preserves unsupported code', async () => {
    const html = [
      '<pre><code class="language-javascript">const answer = 42</code></pre>',
      '<pre><code class="language-ruby">puts &quot;hello&quot;</code></pre>',
      '<pre><code>language-free &lt;text&gt;</code></pre>',
    ].join('')
    const output = await enhanceHtml(html, 'tanstack')

    expect(output).toContain('class="th-code th-code--js"')
    expect(output).toContain('data-language="js"')
    expect(output).toContain('class="th-code th-code--plaintext"')
    expect(output).toContain('puts &quot;hello&quot;')
    expect(output).toContain(
      '<pre><code>language-free &lt;text&gt;</code></pre>',
    )
  })

  test('leaves Mermaid blocks available for client-side rendering', async () => {
    const html =
      '<pre><code class="language-mermaid">flowchart LR\nA --&gt; B</code></pre>'

    expect(await enhanceHtml(html, 'tanstack')).toBe(html)
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
