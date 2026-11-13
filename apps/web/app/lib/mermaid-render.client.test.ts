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
  beforeEach(() => {
    render.mockClear()
  })

  test('renders TanStack blocks while preserving hidden source for comments', async () => {
    const doc = new DOMParser().parseFromString(
      '<body data-artifact-markdown><article data-comment-content><pre><code class="language-mermaid">flowchart LR\nA --&gt; B</code></pre></article></body>',
      'text/html',
    )

    await renderMermaidInDocument(doc, true)

    // Observe initialization in the test that first loads the cached renderer.
    const { default: mermaid } = await import('mermaid')
    expect(mermaid.initialize).toHaveBeenCalledWith(
      expect.objectContaining({
        theme: 'default',
        securityLevel: 'strict',
        suppressErrorRendering: true,
        htmlLabels: false,
        flowchart: { useMaxWidth: false },
        sequence: { useMaxWidth: false },
      }),
    )
    expect(render).toHaveBeenCalledWith(
      expect.stringMatching(/^artifactshare-mermaid-/),
      'flowchart LR\nA --> B',
    )
    const diagram = doc.querySelector<HTMLElement>('.mermaid-diagram')!
    expect(diagram.tabIndex).toBe(0)
    expect(diagram.getAttribute('role')).toBe('region')
    expect(diagram.getAttribute('aria-label')).toBe('Mermaid diagram')
    expect(doc.querySelector('.mermaid-diagram svg')).not.toBeNull()
    expect(doc.querySelector('.mermaid-diagram script')).toBeNull()
    expect(
      doc.querySelector('.mermaid-diagram svg')?.hasAttribute('onload'),
    ).toBe(false)
    expect(doc.querySelector('pre')?.hasAttribute('hidden')).toBe(true)
    expect(doc.querySelector('pre')?.textContent).toBe('flowchart LR\nA --> B')
  })

  test('ignores output without the trusted Markdown marker', async () => {
    const doc = new DOMParser().parseFromString(
      '<body><pre><code class="language-mermaid">flowchart LR</code></pre></body>',
      'text/html',
    )

    await renderMermaidInDocument(doc, true)

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
      `<body data-artifact-markdown>${blocks}</body>`,
      'text/html',
    )

    await renderMermaidInDocument(doc, true)

    expect(render).toHaveBeenCalledTimes(16)
    expect(doc.querySelectorAll('.mermaid-diagram')).toHaveLength(16)
    expect(doc.querySelectorAll('pre:not([hidden])')).toHaveLength(24)
  })

  test('does not trust a TanStack marker on a non-Markdown export', async () => {
    const doc = new DOMParser().parseFromString(
      '<body data-artifact-markdown><pre><code class="language-mermaid">flowchart LR</code></pre></body>',
      'text/html',
    )

    await renderMermaidInDocument(doc, false)

    expect(render).not.toHaveBeenCalled()
    expect(doc.querySelector('.mermaid-diagram')).toBeNull()
  })
})

test('keeps failed source visible while rendering its neighbor with intrinsic sizing', async () => {
  render.mockRejectedValueOnce(new Error('Invalid syntax'))
  const doc = new DOMParser().parseFromString(
    '<body data-artifact-markdown><pre><code class="language-mermaid">invalid</code></pre><pre><code class="language-mermaid">flowchart LR\nA --&gt; B</code></pre></body>',
    'text/html',
  )
  await renderMermaidInDocument(doc, true)
  const blocks = doc.querySelectorAll('pre')
  expect(blocks[0].classList.contains('mermaid-error')).toBe(true)
  expect(blocks[0].hidden).toBe(false)
  expect(blocks[0].textContent).toBe('invalid')
  expect(blocks[1].hidden).toBe(true)
  expect(doc.querySelectorAll('.mermaid-diagram')).toHaveLength(1)
})
