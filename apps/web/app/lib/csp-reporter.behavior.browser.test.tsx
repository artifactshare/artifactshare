import { afterEach, describe, expect, test } from 'vitest'
import { page, userEvent } from 'vitest/browser'
import { VIOLATION_REPORTER_SCRIPT_BODY } from './csp-reporter'
import { renderMermaidSvg, sanitizeMermaidSvg } from './mermaid-render.client'
import {
  buildPrintDocument,
  resolveExportHtml,
} from '../routes/a.$id/+components/export-actions'

type ReporterMessage = { kind?: string; [key: string]: unknown }

let frame: HTMLIFrameElement | undefined
let messages: ReporterMessage[] = []

async function fixture(
  body = '<a id="normal" href="?artifact-link=1">Normal link</a><a id="target" href="?artifact-link=1">Highlighted text</a>',
) {
  messages = []
  window.addEventListener('message', onMessage)
  frame = document.createElement('iframe')
  frame.srcdoc = `<body style="margin:40px;background:white"><div id="content">${body}</div><script>${VIOLATION_REPORTER_SCRIPT_BODY}</script></body>`
  document.body.replaceChildren(frame)
  await new Promise<void>((resolve) =>
    frame?.addEventListener('load', () => resolve(), { once: true }),
  )
  await new Promise((resolve) => setTimeout(resolve, 20))
  return frame.contentDocument!
}

function onMessage(event: MessageEvent<ReporterMessage>) {
  if (event.source === frame?.contentWindow) messages.push(event.data)
}

async function applyHighlights(highlights: unknown[]) {
  frame!.contentWindow!.postMessage(
    {
      source: 'artifactshare-parent',
      kind: 'comment-highlights',
      textAnchorsEnabled: true,
      highlights,
    },
    '*',
  )
  await new Promise((resolve) => setTimeout(resolve, 30))
}

function selected() {
  return messages.find((message) => message.kind === 'comment-thread-selected')
}

afterEach(() => {
  window.removeEventListener('message', onMessage)
  frame?.remove()
  frame = undefined
})

describe('CSP reporter runtime behavior', () => {
  test('marks matching desktop and mobile table-of-contents links as current', async () => {
    const doc = await fixture(
      '<nav class="md-toc"><a href="#intro">Intro</a></nav><details><nav class="md-toc"><a href="#intro">Intro</a></nav></details><h2 id="intro">Intro</h2>',
    )
    doc.defaultView!.dispatchEvent(new Event('scroll'))

    expect(
      doc.querySelectorAll('.md-toc a[aria-current="location"]'),
    ).toHaveLength(2)
  })

  test('sanitizes Mermaid SVG before it reaches the artifact frame', () => {
    const sanitized = sanitizeMermaidSvg(
      '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><text>Safe</text><script>alert(1)</script></svg>',
    )

    expect(sanitized).toContain('<svg')
    expect(sanitized).toContain('<text>Safe</text>')
    expect(sanitized).not.toContain('onload')
    expect(sanitized).not.toContain('<script')
  })

  test('renders Mermaid only after the parent ready check and preserves source text', async () => {
    const source = 'flowchart LR\nA --> B'
    const doc = await fixture(
      `<pre><code class="language-mermaid">${source}</code></pre>`,
    )
    doc.body.dataset.markdownRenderer = 'tanstack'
    messages = []

    frame!.contentWindow!.postMessage(
      {
        source: 'artifactshare-parent',
        kind: 'ready-check',
        challenge: 'browser-test',
      },
      '*',
    )
    await new Promise((resolve) => setTimeout(resolve, 20))
    const request = messages.find(
      (message) => message.kind === 'mermaid-render-request',
    ) as
      | {
          renderToken?: string
          diagrams?: Array<{ id: string; source: string }>
        }
      | undefined
    expect(request?.renderToken).toBe('browser-test')
    expect(request?.diagrams).toEqual([
      { id: 'artifactshare-mermaid-0', source },
    ])

    const svg = await renderMermaidSvg(source)
    frame!.contentWindow!.postMessage(
      {
        source: 'artifactshare-parent',
        kind: 'mermaid-rendered',
        renderToken: 'previous-document',
        results: [{ id: request!.diagrams![0].id, svg }],
      },
      '*',
    )
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(doc.querySelector('.mermaid-diagram')).toBeNull()

    frame!.contentWindow!.postMessage(
      {
        source: 'artifactshare-parent',
        kind: 'mermaid-rendered',
        renderToken: request!.renderToken,
        results: [{ id: request!.diagrams![0].id, svg }],
      },
      '*',
    )
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(doc.querySelector('.mermaid-diagram svg')).not.toBeNull()
    expect(doc.querySelector('pre')?.hidden).toBe(true)
    expect(doc.querySelector('pre')?.textContent).toBe(source)

    await applyHighlights([
      {
        threadId: 'mermaid-source',
        textStart: 0,
        textEnd: source.length,
        count: 1,
      },
    ])
    expect(doc.querySelector('.ash-comment-highlight')?.textContent).toBe(
      source,
    )
  })

  test('uses the same Mermaid rendering for HTML and print exports', async () => {
    const source = 'flowchart LR\nA --> B'
    const data = {
      kind: 'markdown' as const,
      artifactKind: 'markdown_page',
      path: '/index.md',
      versionId: 'version-1',
      source: `\`\`\`mermaid\n${source}\n\`\`\``,
      fileName: 'diagram.md',
      renderedHtml: `<html><body data-markdown-renderer="tanstack"><article data-comment-content><pre><code class="language-mermaid">${source}</code></pre></article></body></html>`,
    }

    const html = await resolveExportHtml('artifact-1', data)
    expect(html).toContain('class="mermaid-diagram"')
    expect(html).toContain('<svg')
    expect(html).toContain('data-mermaid-rendered="true" hidden')

    const print = await buildPrintDocument('artifact-1', data, {
      savePdf: 'Save PDF',
      backgroundHint: 'Print backgrounds',
      preparing: 'Preparing',
      heightLimited: 'Height limited',
    })
    expect(print.querySelector('.mermaid-diagram svg')).not.toBeNull()
    expect(print.querySelector('pre')?.hidden).toBe(true)
  })

  test('keyboard operation on a comment badge sends selection to the parent', async () => {
    const doc = await fixture('<p>Highlighted text</p>')
    await applyHighlights([
      { threadId: 'thread-1', textStart: 0, textEnd: 16, count: 1 },
    ])
    const badge = doc.querySelector<HTMLButtonElement>(
      '.ash-comment-highlight-badge',
    )!
    await userEvent.tab()
    expect(doc.activeElement).toBe(badge)
    messages = []
    await userEvent.keyboard('{Enter}')
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(selected()?.threadId).toBe('thread-1')
  })

  test('highlight and badge clicks are excluded while a normal link click is reported', async () => {
    const doc = await fixture()
    await applyHighlights([
      { threadId: 'thread-2', textStart: 11, textEnd: 27, count: 1 },
    ])
    const reporter = page.frameLocator(page.elementLocator(frame!))
    await reporter.getByText('Highlighted text', { exact: true }).click()
    await reporter.getByLabelText('Open 1 unresolved comment on').click()
    expect(
      messages.filter((message) => message.kind === 'link-clicked'),
    ).toHaveLength(0)
    await reporter.getByText('Normal link', { exact: true }).click()
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(
      messages.filter((message) => message.kind === 'link-clicked'),
    ).toHaveLength(1)
  })

  test('highlight and badge pointerdown are excluded while outside pointerdown is reported', async () => {
    const doc = await fixture()
    await applyHighlights([
      { threadId: 'thread-3', textStart: 11, textEnd: 27, count: 1 },
    ])
    doc
      .querySelector<HTMLElement>('.ash-comment-highlight')!
      .dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
    doc
      .querySelector<HTMLElement>('.ash-comment-highlight-badge')!
      .dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(
      messages.filter(
        (message) => message.kind === 'comment-outside-pointer-down',
      ),
    ).toHaveLength(0)

    doc
      .querySelector('#content')!
      .dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(
      messages.filter(
        (message) => message.kind === 'comment-outside-pointer-down',
      ),
    ).toHaveLength(1)
  })

  test('highlight palette follows a light or dark background', async () => {
    const light = await fixture('<p id="text">Highlighted text</p>')
    await applyHighlights([
      { threadId: 'light', textStart: 0, textEnd: 16, count: 1 },
    ])
    const lightStyle = light.querySelector<HTMLElement>(
      '.ash-comment-highlight',
    )!.style.cssText
    const dark = await fixture(
      '<p id="text" style="background:rgb(0,0,0)">Highlighted text</p>',
    )
    await applyHighlights([
      { threadId: 'dark', textStart: 0, textEnd: 16, count: 1 },
    ])
    const darkStyle = dark.querySelector<HTMLElement>('.ash-comment-highlight')!
      .style.cssText
    expect(lightStyle).not.toBe(darkStyle)
    expect(lightStyle.replaceAll(' ', '')).toContain(
      'background:rgba(37,99,235,0.16)',
    )
    expect(darkStyle.replaceAll(' ', '')).toContain(
      'background:rgba(96,165,250,0.16)',
    )
  })

  test('badge position is updated from the highlight client rect', async () => {
    const doc = await fixture('<p>Highlighted text</p>')
    await applyHighlights([
      { threadId: 'position', textStart: 0, textEnd: 16, count: 1 },
    ])
    const mark = doc.querySelector<HTMLElement>('.ash-comment-highlight')!
    const badge = doc.querySelector<HTMLElement>(
      '.ash-comment-highlight-badge',
    )!
    expect(badge.style.left).not.toBe('0px')
    expect(badge.style.top).not.toBe('0px')
    const markRect = mark.getBoundingClientRect()
    const badgeRect = badge.getBoundingClientRect()
    expect(Math.abs(badgeRect.left - (markRect.right - 6))).toBeLessThan(2)
    expect(badgeRect.bottom).toBeLessThan(markRect.top + 4)
  })

  test('pointer dragging a badge updates its position without selecting the thread', async () => {
    const doc = await fixture('<p>Highlighted text</p>')
    await applyHighlights([
      { threadId: 'drag', textStart: 0, textEnd: 16, count: 1 },
    ])
    const badge = doc.querySelector<HTMLElement>(
      '.ash-comment-highlight-badge',
    )!
    const before = badge.style.left
    const rect = badge.getBoundingClientRect()
    const pointer = (type: string, x: number, y: number) =>
      badge.dispatchEvent(
        new PointerEvent(type, {
          bubbles: true,
          button: 0,
          clientX: x,
          clientY: y,
          pointerId: 1,
        }),
      )
    pointer('pointerdown', rect.left + 4, rect.top + 4)
    pointer('pointermove', rect.left + 84, rect.top + 44)
    pointer('pointerup', rect.left + 84, rect.top + 44)
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(badge.style.left).not.toBe(before)
    expect(selected()).toBeUndefined()
  })
})
