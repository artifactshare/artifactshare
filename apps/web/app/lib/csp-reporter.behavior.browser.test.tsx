import { afterEach, describe, expect, test, vi } from 'vitest'
import { commands, page, userEvent } from 'vitest/browser'
import { injectReadyReporter } from '@artifactshare/viewer-kit/inject'
import { extractAnchorDocument } from '@artifactshare/viewer-kit/anchor-text'
import type { commentAnchorRoundTrip } from '~/test/comment-anchor-browser-fixture'

declare module 'vitest/browser' {
  interface BrowserCommands {
    commentAnchorRoundTrip: typeof commentAnchorRoundTrip
  }
}
import { VIOLATION_REPORTER_SCRIPT_BODY } from './csp-reporter'
import { renderMermaidSvg, sanitizeMermaidSvg } from './mermaid-render.client'
import {
  buildPrintDocument,
  resolveExportHtml,
} from '../routes/a.$id/+components/export-actions'

type ReporterMessage = { kind?: string; [key: string]: unknown }

let frame: HTMLIFrameElement | undefined
let messages: ReporterMessage[] = []
let probeSequence = 0

async function waitForMessage(
  kind: string,
  predicate: (message: ReporterMessage) => boolean = () => true,
  fromIndex = 0,
) {
  return vi.waitFor(() => {
    const message = messages
      .slice(fromIndex)
      .find((candidate) => candidate.kind === kind && predicate(candidate))
    expect(message).toBeDefined()
    return message!
  })
}

async function probeReporter(challenge?: string) {
  const probe = challenge ?? `browser-test-probe-${probeSequence++}`
  const firstResponseIndex = messages.length
  frame!.contentWindow!.postMessage(
    {
      source: 'artifactshare-parent',
      kind: 'ready-check',
      challenge: probe,
      textAnchorsEnabled: true,
    },
    '*',
  )
  await waitForMessage(
    'ready',
    (message) =>
      message.challenge === probe && typeof message.token === 'string',
    firstResponseIndex,
  )
}

async function fixture(
  body = '<a id="normal" href="?artifact-link=1">Normal link</a><a id="target" href="?artifact-link=1">Highlighted text</a>',
  sourceBacked = false,
) {
  messages = []
  window.addEventListener('message', onMessage)
  frame = document.createElement('iframe')
  frame.srcdoc = sourceBacked
    ? injectReadyReporter(body)
    : `<body style="margin:40px;background:white"><div id="content">${body}</div><script>${VIOLATION_REPORTER_SCRIPT_BODY}</script></body>`
  document.body.replaceChildren(frame)
  await new Promise<void>((resolve) =>
    frame?.addEventListener('load', () => resolve(), { once: true }),
  )
  await probeReporter()
  return frame.contentDocument!
}

function onMessage(event: MessageEvent<ReporterMessage>) {
  if (event.source === frame?.contentWindow) messages.push(event.data)
}

async function applyHighlights(
  highlights: unknown[],
  expectedMarks: number | null = highlights.length,
) {
  frame!.contentWindow!.postMessage(
    {
      source: 'artifactshare-parent',
      kind: 'comment-highlights',
      textAnchorsEnabled: true,
      highlights,
    },
    '*',
  )
  await probeReporter()
  if (expectedMarks === null) return
  await vi.waitFor(() =>
    expect(
      frame!.contentDocument!.querySelectorAll('.ash-comment-highlight'),
    ).toHaveLength(expectedMarks),
  )
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
  test('copies a rendered code block without selecting it for comments', async () => {
    const doc = await fixture(
      '<figure class="md-code-block"><button data-code-copy>Copy</button><pre><code>const answer = 42</code></pre></figure>',
    )
    await applyHighlights([])
    let copied = ''
    Object.defineProperty(doc.defaultView!.navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: (value: string) => {
          copied = value
          return Promise.resolve()
        },
      },
    })
    const button = doc.querySelector<HTMLButtonElement>('[data-code-copy]')!
    button.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
    button.click()
    await vi.waitFor(() => expect(copied).toBe('const answer = 42'))
    await probeReporter()

    expect(copied).toBe('const answer = 42')
    expect(button.textContent).toBe('Copied')
    expect(
      messages.filter(
        (message) => message.kind === 'comment-outside-pointer-down',
      ),
    ).toHaveLength(0)
  })

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
    doc.body.setAttribute('data-artifact-markdown', '')
    messages = []

    frame!.contentWindow!.postMessage(
      {
        source: 'artifactshare-parent',
        kind: 'ready-check',
        challenge: 'browser-test',
      },
      '*',
    )
    const request = (await waitForMessage('mermaid-render-request')) as
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
    await probeReporter(request!.renderToken)
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
    await vi.waitFor(() =>
      expect(doc.querySelector('.mermaid-diagram svg')).not.toBeNull(),
    )

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
      renderedHtml: `<html><body data-artifact-markdown><article data-comment-content><pre><code class="language-mermaid">${source}</code></pre></article></body></html>`,
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
    await waitForMessage(
      'comment-thread-selected',
      (message) => message.threadId === 'thread-1',
    )
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
    await waitForMessage('link-clicked')
    expect(
      messages.filter((message) => message.kind === 'link-clicked'),
    ).toHaveLength(1)
  })

  test('routes external links through the parent until direct mode arrives', async () => {
    const doc = await fixture(
      '<a id="first" href="https://first.example/">First external</a><a id="second" href="https://second.example/">Second external</a><a id="third" href="https://third.example/">Third external</a><iframe id="attacker"></iframe>',
    )
    const opened: string[] = []
    Object.defineProperty(doc.defaultView!, 'open', {
      configurable: true,
      value: (href: string) => {
        opened.push(href)
        return null
      },
    })

    const attacker = doc.querySelector<HTMLIFrameElement>('#attacker')!
    const attackerScript = attacker.contentDocument!.createElement('script')
    attackerScript.textContent = `parent.postMessage(${JSON.stringify({
      source: 'artifactshare-parent',
      kind: 'external-link-policy',
      mode: 'direct',
    })}, '*')`
    attacker.contentDocument!.body.appendChild(attackerScript)
    await probeReporter()

    const reporter = page.frameLocator(page.elementLocator(frame!))
    await reporter.getByText('First external', { exact: true }).click()
    const first = await waitForMessage('link-clicked')
    expect(first.href).toBe('https://first.example/')
    expect(opened).toEqual([])

    frame!.contentWindow!.postMessage(
      {
        source: 'artifactshare-parent',
        kind: 'external-link-policy',
        mode: 'direct',
      },
      '*',
    )
    await probeReporter()
    await reporter.getByText('Second external', { exact: true }).click()
    expect(opened).toEqual(['https://second.example/'])

    frame!.contentWindow!.postMessage(
      {
        source: 'artifactshare-parent',
        kind: 'external-link-policy',
        mode: 'parent',
      },
      '*',
    )
    await probeReporter()
    await reporter.getByText('Third external', { exact: true }).click()
    await expect
      .poll(() => messages.filter((message) => message.kind === 'link-clicked'))
      .toHaveLength(2)
    expect(opened).toEqual(['https://second.example/'])
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
    await probeReporter()
    expect(
      messages.filter(
        (message) => message.kind === 'comment-outside-pointer-down',
      ),
    ).toHaveLength(0)

    doc
      .querySelector('#content')!
      .dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
    await waitForMessage('comment-outside-pointer-down')
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
    await vi.waitFor(() => expect(badge.style.left).not.toBe(before))
    await probeReporter()
    expect(badge.style.left).not.toBe(before)
    expect(selected()).toBeUndefined()
  })
})

describe('source-backed selections persisted by the server', () => {
  const cases = [
    [
      'whitespace',
      '<p id="ws">Spaced     text   with\n   line breaks inside it.</p>',
      '#ws',
      'Spaced',
      '#ws',
      'breaks',
    ],
    [
      'uppercase',
      '<p id="tt" style="text-transform:uppercase">lowercase words shown upper</p>',
      '#tt',
      'lowercase',
      '#tt',
      'words',
    ],
    [
      'hidden source',
      '<p id="hid">Visible start <span style="display:none">HIDDEN</span> visible end.</p>',
      '#hid',
      'start',
      '#hid',
      'visible',
    ],
    [
      'blocks',
      '<ul><li id="l1">List item one</li><li id="l2">List item two</li></ul>',
      '#l1',
      'item',
      '#l2',
      'List',
    ],
  ] as const
  for (const [
    name,
    source,
    startSelector,
    startWord,
    endSelector,
    endWord,
  ] of cases) {
    test(name, async () => {
      let doc = await fixture(source, true)
      function endpoint(selector: string, word: string, end: boolean) {
        const walker = doc.createTreeWalker(
          doc.querySelector(selector)!,
          NodeFilter.SHOW_TEXT,
        )
        let node: Node | null
        while ((node = walker.nextNode())) {
          const at = node.nodeValue!.indexOf(word)
          if (at >= 0) return { node, offset: at + (end ? word.length : 0) }
        }
        throw new Error('fixture endpoint missing')
      }
      const first = endpoint(startSelector, startWord, false),
        last = endpoint(endSelector, endWord, true)
      const range = doc.createRange()
      range.setStart(first.node, first.offset)
      range.setEnd(last.node, last.offset)
      doc.getSelection()!.removeAllRanges()
      doc.getSelection()!.addRange(range)
      doc.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
      const payload = await waitForMessage('text-selection')
      const anchor = {
        quotedText: payload.quotedText as string,
        prefixText: payload.prefixText as string,
        suffixText: payload.suffixText as string,
        textStart: payload.textStart as number,
        textEnd: payload.textEnd as number,
        cssPath: payload.cssPath as string | null,
      }
      const nextSource = source + '<p>Unrelated addition.</p>'
      const result = await commands.commentAnchorRoundTrip({
        source,
        nextSource,
        anchor,
      })
      expect(result.text).toBe(extractAnchorDocument(source).text)
      expect(result.stored).toEqual({
        quoted_text: anchor.quotedText,
        text_start: anchor.textStart,
        text_end: anchor.textEnd,
      })
      expect(result.text.slice(anchor.textStart, anchor.textEnd)).toBe(
        anchor.quotedText,
      )
      for (const thread of [result.origin, result.updated]) {
        if (thread === result.updated) doc = await fixture(nextSource, true)
        expect(thread.subject.kind).toBe('text')
        if (thread.subject.kind !== 'text')
          throw new Error('text subject expected')
        expect(thread.subject.state).toBe('attached')
        await applyHighlights(
          [{ threadId: thread.id, ...thread.subject, count: 1 }],
          null,
        )
        const highlighted = [...doc.querySelectorAll('.ash-comment-highlight')]
          .map((node) => node.textContent)
          .join('')
        expect(highlighted).toBe(anchor.quotedText)
        await applyHighlights([])
        await applyHighlights(
          [{ threadId: thread.id, ...thread.subject, count: 1 }],
          null,
        )
        expect(
          [...doc.querySelectorAll('.ash-comment-highlight')]
            .map((node) => node.textContent)
            .join(''),
        ).toBe(anchor.quotedText)
      }
    })
  }
  test('script additions are excluded and modified source never silently highlights', async () => {
    const doc = await fixture(
      '<p id="text">Hello world</p><script>document.body.prepend(document.createTextNode("Added"))</script>',
      true,
    )
    await applyHighlights([
      { threadId: 'u1', textStart: 6, textEnd: 11, count: 1 },
    ])
    expect(doc.querySelector('.ash-comment-highlight')?.textContent).toBe(
      'world',
    )
    await applyHighlights([])
    doc.querySelector('#text')!.textContent = 'Other world'
    await applyHighlights(
      [{ threadId: 'u1', textStart: 6, textEnd: 11, count: 1 }],
      0,
    )
    expect(doc.querySelector('.ash-comment-highlight')).toBeNull()
  })
})
