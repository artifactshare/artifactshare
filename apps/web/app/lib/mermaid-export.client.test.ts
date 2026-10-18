// @vitest-environment happy-dom
import { afterEach, expect, test, vi } from 'vitest'
import { renderExportMermaidSvg } from './mermaid-export.client'

vi.mock('mermaid/dist/mermaid.min.js?raw', () => ({ default: '' }))
afterEach(() => {
  document.body.replaceChildren()
  vi.restoreAllMocks()
})

test('isolated preparation has no network or same-origin authority and abort removes its listener/frame', async () => {
  const controller = new AbortController()
  const removed = vi.spyOn(window, 'removeEventListener')
  const pending = renderExportMermaidSvg(
    'flowchart LR\nA --> B',
    controller.signal,
  )
  const rejected = expect(pending).rejects.toMatchObject({
    name: 'MermaidResourceError',
  })
  await vi.waitFor(() =>
    expect(document.querySelector('iframe')).not.toBeNull(),
  )
  const frame = document.querySelector('iframe')!
  expect(frame.getAttribute('sandbox')).toBe('allow-scripts')
  expect(frame.srcdoc).toContain("default-src 'none'")
  expect(frame.srcdoc).toContain("connect-src 'none'")
  expect(frame.srcdoc).toContain('img-src data:')
  expect(frame.srcdoc).not.toContain('https:')
  controller.abort()
  await rejected
  expect(frame.isConnected).toBe(false)
  expect(removed.mock.calls.some(([type]) => String(type) === 'message')).toBe(
    true,
  )
})

test('a stalled isolated renderer fails instead of returning incomplete output', async () => {
  const schedule = window.setTimeout.bind(window)
  vi.spyOn(globalThis, 'setTimeout').mockImplementation(
    (handler, timeout, ...args) =>
      schedule(
        handler,
        timeout === 10_000 ? 1 : timeout,
        ...args,
      ) as unknown as ReturnType<typeof globalThis.setTimeout>,
  )
  await expect(
    renderExportMermaidSvg(
      'flowchart LR\nA --> B',
      new AbortController().signal,
    ),
  ).rejects.toMatchObject({
    name: 'MermaidResourceError',
    message: 'Mermaid export timed out',
  })
  expect(document.querySelector('iframe')).toBeNull()
})

test('required bundle failure fails document preparation instead of invalid-source fallback', async () => {
  vi.resetModules()
  vi.doMock('mermaid/dist/mermaid.min.js?raw', () => {
    throw new Error('Bundle unavailable')
  })
  try {
    const { renderExportMermaidSvg: render } =
      await import('./mermaid-export.client')
    const { renderMermaidInDocument } = await import('./mermaid-render.client')
    document.body.setAttribute('data-artifact-markdown', '')
    document.body.innerHTML =
      '<pre><code class="language-mermaid">flowchart LR\nA --&gt; B</code></pre>'
    await expect(
      renderMermaidInDocument(document, true, (source) =>
        render(source, new AbortController().signal),
      ),
    ).rejects.toMatchObject({
      name: 'MermaidResourceError',
      message: 'Mermaid bundle unavailable',
    })
    expect(document.querySelector('.mermaid-error')).toBeNull()
    expect(document.querySelector('iframe')).toBeNull()
  } finally {
    vi.doMock('mermaid/dist/mermaid.min.js?raw', () => ({ default: '' }))
    vi.resetModules()
  }
})

test.each(['render-error', 'failed', 'blocked'])(
  'renderer status %s distinguishes ordinary fallback from hard failures',
  async (kind) => {
    const result = renderExportMermaidSvg(
      'flowchart LR\nA --> B',
      new AbortController().signal,
    )
    const rejected = expect(result).rejects.toMatchObject({
      name: kind === 'render-error' ? 'Error' : 'MermaidResourceError',
    })
    await vi.waitFor(() =>
      expect(document.querySelector('iframe')).not.toBeNull(),
    )
    const frame = document.querySelector('iframe')!
    const channel = /channel:"([^"]+)"/.exec(frame.srcdoc)![1]
    window.dispatchEvent(
      new MessageEvent('message', {
        source: frame.contentWindow,
        origin: 'null',
        data: { channel, kind },
      }),
    )
    await rejected
    expect(frame.isConnected).toBe(false)
  },
)

test('ordinary render failure cannot hide an outstanding image acquisition failure', async () => {
  let rejectImage!: (error: Error) => void
  const image = new Promise<string>((_resolve, reject) => {
    rejectImage = reject
  })
  const result = renderExportMermaidSvg(
    'flowchart LR\nA --> B',
    new AbortController().signal,
    () => image,
  )
  const rejected = expect(result).rejects.toMatchObject({
    name: 'MermaidResourceError',
  })
  await vi.waitFor(() =>
    expect(document.querySelector('iframe')).not.toBeNull(),
  )
  const frame = document.querySelector('iframe')!
  const channel = /channel:"([^"]+)"/.exec(frame.srcdoc)![1]
  const send = (data: object) =>
    window.dispatchEvent(
      new MessageEvent('message', {
        source: frame.contentWindow,
        origin: 'null',
        data: { channel, ...data },
      }),
    )
  send({ kind: 'image', sequence: 1, ref: 'image.png' })
  send({ kind: 'render-error' })
  rejectImage(new Error('Image unavailable'))
  await rejected
  expect(frame.isConnected).toBe(false)
})
