// @vitest-environment happy-dom

import { beforeEach, describe, expect, test, vi } from 'vitest'

const render = vi.fn(async (_id: string, source: string) => ({
  svg: `<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><text>${source}</text><script>alert(1)</script></svg>`,
}))

vi.mock('mermaid', () => ({
  default: {
    initialize: vi.fn(),
    render,
  },
}))

vi.mock('dompurify', () => ({
  default: {
    sanitize: (svg: string) =>
      svg.replace(/ onload="[^"]*"/g, '').replace(/<script>.*<\/script>/g, ''),
  },
}))

import { renderMermaidInDocument } from './mermaid-render.client'

describe('renderMermaidInDocument', () => {
  beforeEach(() => render.mockClear())

  test('renders TanStack blocks while preserving hidden source for comments', async () => {
    const doc = new DOMParser().parseFromString(
      '<body data-markdown-renderer="tanstack"><article data-comment-content><pre><code class="language-mermaid">flowchart LR\nA --&gt; B</code></pre></article></body>',
      'text/html',
    )

    await renderMermaidInDocument(doc)

    expect(render).toHaveBeenCalledWith(
      expect.stringMatching(/^artifactshare-mermaid-/),
      'flowchart LR\nA --> B',
    )
    expect(doc.querySelector('.mermaid-diagram svg')).not.toBeNull()
    expect(doc.querySelector('.mermaid-diagram script')).toBeNull()
    expect(
      doc.querySelector('.mermaid-diagram svg')?.hasAttribute('onload'),
    ).toBe(false)
    expect(doc.querySelector('pre')?.hasAttribute('hidden')).toBe(true)
    expect(doc.querySelector('pre')?.textContent).toBe('flowchart LR\nA --> B')
  })

  test('leaves Marked output unchanged', async () => {
    const doc = new DOMParser().parseFromString(
      '<body data-markdown-renderer="marked"><pre><code class="language-mermaid">flowchart LR</code></pre></body>',
      'text/html',
    )

    await renderMermaidInDocument(doc)

    expect(render).not.toHaveBeenCalled()
    expect(doc.querySelector('.mermaid-diagram')).toBeNull()
    expect(doc.querySelector('pre')?.hasAttribute('hidden')).toBe(false)
  })

  test('caps export rendering to the live viewer limit', async () => {
    const blocks = Array.from(
      { length: 40 },
      (_, index) =>
        `<pre><code class="language-mermaid">flowchart LR\nA${index} --&gt; B${index}</code></pre>`,
    ).join('')
    const doc = new DOMParser().parseFromString(
      `<body data-markdown-renderer="tanstack">${blocks}</body>`,
      'text/html',
    )

    await renderMermaidInDocument(doc)

    expect(render).toHaveBeenCalledTimes(16)
    expect(doc.querySelectorAll('.mermaid-diagram')).toHaveLength(16)
    expect(doc.querySelectorAll('pre:not([hidden])')).toHaveLength(24)
  })
})
