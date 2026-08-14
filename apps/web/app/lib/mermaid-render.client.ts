import DOMPurify from 'dompurify'

const MAX_MERMAID_SOURCE_LENGTH = 20_000
const MAX_MERMAID_DIAGRAMS = 16

let mermaidPromise: Promise<(typeof import('mermaid'))['default']> | null = null

async function getMermaid() {
  mermaidPromise ??= import('mermaid').then(({ default: mermaid }) => {
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      suppressErrorRendering: true,
      htmlLabels: false,
    })
    return mermaid
  })
  try {
    return await mermaidPromise
  } catch (error) {
    mermaidPromise = null
    throw error
  }
}

export async function renderMermaidSvg(source: string): Promise<string> {
  if (!source.trim()) throw new Error('Mermaid source is empty')
  if (source.length > MAX_MERMAID_SOURCE_LENGTH) {
    throw new Error('Mermaid source is too large')
  }
  const mermaid = await getMermaid()
  const id = `artifactshare-mermaid-${crypto.randomUUID().replaceAll('-', '')}`
  const { svg } = await mermaid.render(id, source)
  return sanitizeMermaidSvg(svg)
}

export function sanitizeMermaidSvg(svg: string): string {
  return DOMPurify.sanitize(svg, {
    USE_PROFILES: { svg: true, svgFilters: true },
  })
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

export async function renderMermaidInDocument(
  doc: Document,
  trustedMarkdown: boolean,
): Promise<void> {
  if (!trustedMarkdown || !doc.body.hasAttribute('data-artifact-markdown'))
    return
  const blocks: Array<{ pre: HTMLElement; source: string }> = []
  for (const block of doc.querySelectorAll<HTMLElement>(
    'pre code.language-mermaid',
  )) {
    const pre = block.closest('pre')
    const source = block.textContent ?? ''
    if (!pre || !source || source.length > MAX_MERMAID_SOURCE_LENGTH) continue
    blocks.push({ pre, source })
    if (blocks.length === MAX_MERMAID_DIAGRAMS) break
  }
  const rendered = await blocks.reduce<
    Promise<Array<{ pre: HTMLElement; svg: string }>>
  >(async (pending, { pre, source }) => {
    // Mermaid diagram renderers share temporary DOM state, so keep the batch sequential.
    // react-doctor-disable-next-line react-doctor/async-await-in-loop
    const results = await pending
    if (pre.dataset.mermaidRendered === 'true') return results
    try {
      results.push({ pre, svg: await renderMermaidSvg(source) })
    } catch {
      pre.classList.add('mermaid-error')
    }
    return results
  }, Promise.resolve([]))
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
