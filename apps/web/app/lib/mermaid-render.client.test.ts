// @vitest-environment happy-dom

import { beforeEach, describe, expect, test, vi } from 'vitest'

const render = vi.fn(async (_id: string, source: string) => ({
  svg: `<svg xmlns="http://www.w3.org/2000/svg"><text>${source}</text></svg>`,
}))

vi.mock('mermaid', () => ({
  default: {
    initialize: vi.fn(),
    render,
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
})
