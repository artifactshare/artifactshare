const MAX_MERMAID_SOURCE_LENGTH = 100_000

let mermaidPromise: Promise<(typeof import('mermaid'))['default']> | null = null

async function getMermaid() {
  mermaidPromise ??= import('mermaid').then(({ default: mermaid }) => {
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      suppressErrorRendering: true,
    })
    return mermaid
  })
  return await mermaidPromise
}

export async function renderMermaidSvg(source: string): Promise<string> {
  if (!source.trim()) throw new Error('Mermaid source is empty')
  if (source.length > MAX_MERMAID_SOURCE_LENGTH) {
    throw new Error('Mermaid source is too large')
  }
  const mermaid = await getMermaid()
  const id = `artifactshare-mermaid-${crypto.randomUUID().replaceAll('-', '')}`
  return (await mermaid.render(id, source)).svg
}

function appendMermaidSvg(doc: Document, container: HTMLElement, svg: string) {
  const parsed = new DOMParser().parseFromString(svg, 'image/svg+xml')
  const root = parsed.documentElement
  if (
    root.localName !== 'svg' ||
    root.namespaceURI !== 'http://www.w3.org/2000/svg' ||
    parsed.querySelector('parsererror')
  ) {
    throw new Error('Mermaid returned invalid SVG')
  }
  container.appendChild(doc.importNode(root, true))
}

export async function renderMermaidInDocument(doc: Document): Promise<void> {
  if (doc.body.dataset.markdownRenderer !== 'tanstack') return
  const blocks = Array.from(
    doc.querySelectorAll<HTMLElement>('pre code.language-mermaid'),
  )
  const rendered = await Promise.all(
    blocks.map(async (block) => {
      const pre = block.closest('pre')
      if (!pre || pre.dataset.mermaidRendered === 'true') return null
      try {
        return {
          pre,
          svg: await renderMermaidSvg(block.textContent ?? ''),
        }
      } catch {
        pre.classList.add('mermaid-error')
        return null
      }
    }),
  )
  for (const result of rendered) {
    if (!result) continue
    try {
      const container = doc.createElement('div')
      container.className = 'mermaid-diagram'
      appendMermaidSvg(doc, container, result.svg)
      result.pre.dataset.mermaidRendered = 'true'
      result.pre.hidden = true
      result.pre.parentNode?.insertBefore(container, result.pre)
    } catch {
      result.pre.classList.add('mermaid-error')
    }
  }
}
