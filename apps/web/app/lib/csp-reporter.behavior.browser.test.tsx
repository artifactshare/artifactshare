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
  transform: (html: string) => string = (html) => html,
) {
  messages = []
  window.addEventListener('message', onMessage)
  frame = document.createElement('iframe')
  frame.srcdoc = transform(
    sourceBacked
      ? injectReadyReporter(body)
      : `<body style="margin:40px;background:white"><div id="content">${body}</div><script>${VIOLATION_REPORTER_SCRIPT_BODY}</script></body>`,
  )
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
  test('preview verification accepts the mapped current slice and never searches the original quote', async () => {
    await fixture('<p>Hello woNEWrld</p>', true)
    frame!.contentWindow!.postMessage(
      {
        source: 'artifactshare-parent',
        kind: 'verify-anchors',
        anchors: [
          {
            thread: 'a1',
            kind: 'text',
            state: 'attached',
            textStart: 6,
            textEnd: 14,
            quotedText: 'world',
            currentText: 'woNEWrld',
          },
          {
            thread: 'a2',
            kind: 'text',
            state: 'attached',
            textStart: 6,
            textEnd: 11,
            quotedText: 'world',
          },
        ],
      },
      '*',
    )
    expect((await waitForMessage('anchor-verdicts')).verdicts).toEqual([
      { thread: 'a1', attached: true },
      { thread: 'a2', attached: false },
    ])
  })

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
    [
      'formatted document',
      '<!doctype html>\n<html><head></head><body><p id="target">Hello world</p>\n</body>\n</html>\n',
      '#target',
      'Hello',
      '#target',
      'world',
    ],
    [
      'after body whitespace',
      '<html><body><p id="target">Hello world</p></body>\n</html>',
      '#target',
      'Hello',
      '#target',
      'world',
    ],
    [
      'after body text',
      '<html><body><p id="target">Hello world</p></body>Tail</html>',
      '#target',
      'Hello',
      '#target',
      'world',
    ],
    [
      'fostered table text',
      '<table>Before<tr><td id="target">Hello world</td></tr>After</table>',
      '#target',
      'Hello',
      '#target',
      'world',
    ],
    [
      'merged text before table and reconstructed formatting',
      '<p>Intro</p>\n<table>Before<b><tr><td>Cell</td></tr>After words</table>',
      'body > b:nth-of-type(2)',
      'After',
      'body > b:nth-of-type(2)',
      'words',
    ],
    [
      'merged text before table and fostered div',
      'Inline<table>Before<div id="target">Middle words</div><tr><td>Cell</td></tr>After</table>',
      '#target',
      'Middle',
      '#target',
      'words',
    ],
    [
      'plain fostered text before reconstructed formatting',
      '<table>Before<b><tr><td>Cell</td></tr>After words</table>',
      'body > b:nth-of-type(2)',
      'After',
      'body > b:nth-of-type(2)',
      'words',
    ],
    [
      'reconstructed formatting around fostered text',
      '<table><b><tr><td>Cell</td></tr>Fostered words</table>After',
      'body > b:nth-of-type(2)',
      'Fostered',
      'body > b:nth-of-type(2)',
      'words',
    ],
    [
      'multiple reconstructed formatting elements',
      '<table><b><i>Before<tr><td>Cell</td></tr>After words</table>End',
      'body > b:nth-of-type(2) > i',
      'After',
      'body > b:nth-of-type(2) > i',
      'words',
    ],
    [
      'bare document text',
      'Before<p id="target">Hello world</p>',
      '#target',
      'Hello',
      '#target',
      'world',
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
  test.each(['html', 'head'])(
    'authored %s manifest id collisions preserve readiness and source selections',
    async (tag) => {
      const doc = await fixture(
        `<html ${tag === 'html' ? 'id="ash-source-manifest"' : ''}><head ${tag === 'head' ? 'id="ash-source-manifest"' : ''}></head><body><p id="target">Select words</p></body></html>`,
        true,
      )
      const range = doc.createRange()
      range.selectNodeContents(doc.querySelector('#target')!)
      doc.getSelection()!.addRange(range)
      doc.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
      expect((await waitForMessage('text-selection')).quotedText).toBe(
        'Select words',
      )
    },
  )
  test('an unavailable source still responds to ready probes and suppresses text highlights', async () => {
    const doc = await fixture(
      '<p id="target">Select words</p>',
      false,
      (html) =>
        html.replace('<script>', '<script data-ash-source-unavailable>'),
    )
    await applyHighlights(
      [
        {
          threadId: 'c1',
          textStart: 0,
          textEnd: 12,
          state: 'attached',
          count: 1,
        },
      ],
      0,
    )
    expect(doc.querySelector('.ash-comment-highlight')).toBeNull()
  })
  test('malformed injected metadata disables text anchors but keeps the ready handshake', async () => {
    const doc = await fixture('<p id="target">Select words</p>', true, (html) =>
      html.replace(
        'id="ash-source-manifest">["Select words"]',
        'id="ash-source-manifest">invalid',
      ),
    )
    await applyHighlights(
      [
        {
          threadId: 'c1',
          textStart: 0,
          textEnd: 12,
          state: 'attached',
          count: 1,
        },
      ],
      0,
    )
    expect(doc.querySelector('.ash-comment-highlight')).toBeNull()
  })
  test.each(['xmp', 'iframe', 'noembed', 'noframes', 'plaintext'])(
    'raw-text %s is unchanged and text elsewhere remains selectable',
    async (tag) => {
      const doc = await fixture(
        `<p id="target">Select words</p><${tag}>Raw fallback</${tag}>`,
        true,
      )
      expect(doc.querySelector(tag)!.textContent).toBe(
        tag === 'plaintext' ? 'Raw fallback</plaintext>' : 'Raw fallback',
      )
      const range = doc.createRange()
      range.selectNodeContents(doc.querySelector('#target')!)
      doc.getSelection()!.addRange(range)
      doc.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
      expect((await waitForMessage('text-selection')).quotedText).toBe(
        'Select words',
      )
    },
  )
  test.each([false, true])(
    'reordered source regions cannot highlight (during parsing: %s)',
    async (duringParsing) => {
      const reorder = 'document.body.prepend(document.getElementById("second"))'
      const source = '<p id="first">Same words</p><p id="second">Same words</p>'
      const doc = await fixture(
        source + (duringParsing ? `<script>${reorder}</script>` : ''),
        true,
      )
      if (!duringParsing) {
        await applyHighlights([
          { threadId: 'u1', textStart: 0, textEnd: 4, count: 1 },
        ])
        expect(
          doc.querySelector('#first .ash-comment-highlight')?.textContent,
        ).toBe('Same')
        await applyHighlights([])
        doc.body.insertBefore(
          doc.querySelector('#second')!,
          doc.body.firstChild,
        )
      }
      await applyHighlights(
        [{ threadId: 'u1', textStart: 0, textEnd: 4, count: 1 }],
        0,
      )
      expect(doc.querySelector('.ash-comment-highlight')).toBeNull()
    },
  )

  test.each(['text node', 'region markup'])(
    'equal-value replacement of %s preserves selection and reapplies highlights',
    async (replacement) => {
      const doc = await fixture('<p id="text">Hello world</p>', true)
      const target = doc.querySelector('#text')!
      const originalMarkup = target.innerHTML
      const highlights = [
        { threadId: 'u1', textStart: 6, textEnd: 11, count: 1 },
      ]
      await applyHighlights(highlights)
      if (replacement === 'region markup') target.innerHTML = originalMarkup
      else {
        const text = doc.querySelector('.ash-comment-highlight')!.firstChild!
        text.parentNode!.replaceChild(
          doc.createTextNode(text.textContent!),
          text,
        )
      }
      // Reapply the same highlight payload after the DOM replacement.
      await applyHighlights(highlights)
      expect(target.querySelector('.ash-comment-highlight')?.textContent).toBe(
        'world',
      )
      const range = doc.createRange()
      range.selectNodeContents(target)
      doc.getSelection()!.addRange(range)
      doc.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
      expect(await waitForMessage('text-selection')).toMatchObject({
        quotedText: 'Hello world',
        textStart: 0,
        textEnd: 11,
      })
      await applyHighlights([])
      await applyHighlights(highlights)
      expect(target.querySelector('.ash-comment-highlight')?.textContent).toBe(
        'world',
      )
    },
  )

  test.each([
    ['Hello world', 6, 11, 'Hello', ' world'],
    ['same same', 5, 9, 'same', ' same'],
  ] as const)(
    'rebuilds connected highlights at resolved offsets after equal-value rewrites: %s',
    async (text, textStart, textEnd, movedText, trailingText) => {
      const doc = await fixture(`<p id="text">${text}</p>`, true)
      const target = doc.querySelector('#text')!
      const highlights = [{ threadId: 'u1', textStart, textEnd, count: 1 }]
      await applyHighlights(highlights)
      const mark = target.querySelector('.ash-comment-highlight')!
      const badge = target.querySelector('.ash-comment-highlight-badge')!
      const prefix = mark.previousSibling!
      const suffix = doc.createTextNode('')
      badge.parentNode!.insertBefore(suffix, badge.nextSibling)
      expect(prefix.nodeType).toBe(Node.TEXT_NODE)
      expect(suffix.nodeType).toBe(Node.TEXT_NODE)
      prefix.nodeValue = ''
      mark.firstChild!.nodeValue = movedText
      suffix.nodeValue = trailingText
      expect(target.textContent).toBe(text)
      expect(mark.isConnected).toBe(true)
      expect(badge.isConnected).toBe(true)

      // Neither the region value nor the highlight payload changed. The mark
      // now covers offset zero, which must not pass as the requested position.
      await applyHighlights(highlights)
      const current = target.querySelector('.ash-comment-highlight')!
      expect(current.textContent).toBe(text.slice(textStart, textEnd))
      const before = doc.createRange()
      before.selectNodeContents(target)
      before.setEndBefore(current)
      expect(before.toString().length).toBe(textStart)
      expect(target.textContent).toBe(text)
      expect(target.querySelectorAll('.ash-comment-highlight')).toHaveLength(1)
      expect(
        target.querySelectorAll('.ash-comment-highlight-badge'),
      ).toHaveLength(1)
    },
  )

  test('highlight cleanup preserves authored text-node references, including siblings in the same parent', async () => {
    const doc = await fixture('<p id="text">Hello world</p>', true)
    const target = doc.querySelector('#text')!
    const original = Array.from(target.childNodes).find(
      (node) => node.nodeType === Node.TEXT_NODE,
    ) as Text
    const sibling = original.splitText(5)
    const highlights = [{ threadId: 'u1', textStart: 6, textEnd: 11, count: 1 }]
    const assertReferences = () => {
      expect(original.parentNode).toBe(target)
      expect(sibling.parentNode).toBe(target)
      expect(original.data).toBe('Hello')
      expect(sibling.data).toBe(' world')
    }
    await applyHighlights([])
    assertReferences()
    await applyHighlights(highlights)
    await applyHighlights([])
    assertReferences()
    // A framework-style update must still affect its mounted text node.
    sibling.data = ' other'
    await applyHighlights(highlights, 0)
    await applyHighlights([], 0)
    expect(sibling.parentNode).toBe(target)
    expect(target.textContent).toBe('Hello other')
    sibling.data = ' world'
    await applyHighlights(highlights)
    await applyHighlights([])
    assertReferences()
  })

  test.each([
    ['whole node', [[0, 11]], ''],
    ['start', [[0, 5]], ' world'],
    ['middle', [[3, 8]], 'lo world'],
    ['end', [[6, 11]], 'world'],
    [
      'multiple marks',
      [
        [0, 5],
        [6, 11],
      ],
      ' world',
    ],
  ] as const)(
    'cleanup preserves live text and a rewritten node reference: %s',
    async (_label, ranges, remainingText) => {
      const doc = await fixture('<p id="text">Hello world</p>', true)
      const target = doc.querySelector('#text')!
      const original = Array.from(target.childNodes).find(
        (node) => node.nodeType === Node.TEXT_NODE,
      ) as Text
      await applyHighlights(
        ranges.map(([textStart, textEnd], index) => ({
          threadId: `u${index + 1}`,
          textStart,
          textEnd,
          count: 1,
        })),
      )
      // Frameworks keep this original node, rather than finding our mark child.
      original.data = 'Hello earth'
      // Changing the retained prefix does not tell us whether the page intended
      // to replace the entire original node. Cleanup must preserve the live DOM.
      const liveText = target.textContent!
      expect(liveText).toBe('Hello earth' + remainingText)
      doc.querySelector<HTMLElement>('.ash-comment-highlight')!.click()
      expect(original.parentNode).toBe(target)
      expect(original.data).toBe('Hello earth')
      expect(target.textContent).toBe(liveText)
      expect(doc.querySelector('.ash-comment-highlight')).toBeNull()
      expect(doc.querySelector('.ash-comment-highlight-badge')).toBeNull()
      await probeReporter()
      expect(selected()).toBeUndefined()
      await applyHighlights([])
      expect(target.textContent).toBe(liveText)
      // Further updates through the same retained reference still render.
      original.data = 'Hello again'
      expect(target.textContent).toBe(
        'Hello again' + liveText.slice('Hello earth'.length),
      )
    },
  )

  test.each(['clear message', 'failed click check'])(
    'prefix-only edits preserve the unedited highlight and suffix during %s',
    async (action) => {
      const doc = await fixture('<p id="text">Hello world!</p>', true)
      const target = doc.querySelector('#text')!
      const original = Array.from(target.childNodes).find(
        (node) => node.nodeType === Node.TEXT_NODE,
      ) as Text
      await applyHighlights([
        { threadId: 'u1', textStart: 6, textEnd: 11, count: 1 },
      ])
      expect(original.data).toBe('Hello ')
      original.appendData('dear ')
      expect(target.textContent).toBe('Hello dear world!')
      if (action === 'clear message') await applyHighlights([])
      else doc.querySelector<HTMLElement>('.ash-comment-highlight')!.click()
      expect(target.textContent).toBe('Hello dear world!')
      expect(original.data).toBe('Hello dear ')
      expect(original.parentNode).toBe(target)
      expect(doc.querySelector('.ash-comment-highlight')).toBeNull()
      expect(doc.querySelector('.ash-comment-highlight-badge')).toBeNull()
      await probeReporter()
      expect(selected()).toBeUndefined()
      await applyHighlights([])
      expect(target.textContent).toBe('Hello dear world!')
    },
  )

  test.each(['mark', 'badge'])(
    '%s click rejects an equal-value mark moved to a different canonical position',
    async (action) => {
      const doc = await fixture('<p id="text">same same</p>', true)
      await applyHighlights([
        { threadId: 'u1', textStart: 5, textEnd: 9, count: 1 },
      ])
      const target = doc.querySelector('#text')!
      const mark = target.querySelector<HTMLElement>('.ash-comment-highlight')!
      const badge = target.querySelector<HTMLButtonElement>(
        '.ash-comment-highlight-badge',
      )!
      mark.previousSibling!.nodeValue = ''
      badge.parentNode!.insertBefore(
        doc.createTextNode(' same'),
        badge.nextSibling,
      )
      expect(target.textContent).toBe('same same')
      expect(mark.textContent).toBe('same')
      // Both region text and highlighted words still match. Only position is wrong.
      ;(action === 'mark' ? mark : badge).click()
      expect(doc.querySelector('.ash-comment-highlight')).toBeNull()
      expect(doc.querySelector('.ash-comment-highlight-badge')).toBeNull()
      expect(target.textContent).toBe('same same')
      await probeReporter()
      expect(selected()).toBeUndefined()
    },
  )

  test('scroll navigation rejects a stale mark on another copy of the same text', async () => {
    const doc = await fixture('<p id="text">same same</p>', true)
    await applyHighlights([
      { threadId: 'u1', textStart: 5, textEnd: 9, count: 1 },
    ])
    const target = doc.querySelector('#text')!
    const mark = target.querySelector<HTMLElement>('.ash-comment-highlight')!
    const badge = target.querySelector<HTMLElement>(
      '.ash-comment-highlight-badge',
    )!
    const scrollMark = vi
      .spyOn(mark, 'scrollIntoView')
      .mockImplementation(() => {})
    const scrollBadge = vi
      .spyOn(badge, 'scrollIntoView')
      .mockImplementation(() => {})
    const navigate = async () => {
      frame!.contentWindow!.postMessage(
        {
          source: 'artifactshare-parent',
          kind: 'scroll-to-comment',
          threadId: 'u1',
        },
        '*',
      )
      await probeReporter()
    }
    // Positive control: navigation reaches the verified second occurrence.
    await navigate()
    expect(scrollMark).toHaveBeenCalledOnce()
    scrollMark.mockClear()
    mark.previousSibling!.nodeValue = ''
    badge.parentNode!.insertBefore(
      doc.createTextNode(' same'),
      badge.nextSibling,
    )
    expect(target.textContent).toBe('same same')
    expect(mark.textContent).toBe('same')
    await navigate()
    expect(scrollMark).not.toHaveBeenCalled()
    expect(scrollBadge).not.toHaveBeenCalled()
    expect(target.querySelector('.ash-comment-highlight')).toBeNull()
    expect(target.querySelector('.ash-comment-highlight-badge')).toBeNull()
    expect(target.textContent).toBe('same same')
  })

  test.each(['mark', 'badge'] as const)(
    'scroll navigation ignores an unrecorded %s clone before the validated target',
    async (kind) => {
      const doc = await fixture('<p id="text">same same</p>', true)
      await applyHighlights([
        { threadId: 'u1', textStart: 5, textEnd: 9, count: 1 },
      ])
      const mark = doc.querySelector<HTMLElement>('.ash-comment-highlight')!
      const badge = doc.querySelector<HTMLElement>(
        '.ash-comment-highlight-badge',
      )!
      const clone = (kind === 'mark' ? mark : badge).cloneNode(
        true,
      ) as HTMLElement
      const prefix = mark.previousSibling as Text
      if (kind === 'mark') prefix.data = ' '
      prefix.parentNode!.insertBefore(clone, prefix)
      // The clone precedes the genuine mark without changing canonical text
      // or the genuine mark's range. A selector would choose the clone.
      const scrollClone = vi
        .spyOn(clone, 'scrollIntoView')
        .mockImplementation(() => {})
      const scrollMark = vi
        .spyOn(mark, 'scrollIntoView')
        .mockImplementation(() => {})
      frame!.contentWindow!.postMessage(
        {
          source: 'artifactshare-parent',
          kind: 'scroll-to-comment',
          threadId: 'u1',
        },
        '*',
      )
      await probeReporter()
      expect(scrollClone).not.toHaveBeenCalled()
      expect(scrollMark).toHaveBeenCalledOnce()
      expect(mark.isConnected).toBe(true)
    },
  )

  test.each(['scroll', 'mark', 'badge', 'reapply'] as const)(
    '%s rejects a mark whose canonical end changed while its start and textContent stayed equal',
    async (action) => {
      const doc = await fixture('<p id="text">same same</p>', true)
      const highlights = [
        { threadId: 'u1', textStart: 5, textEnd: 9, count: 1 },
      ]
      await applyHighlights(highlights)
      const mark = doc.querySelector<HTMLElement>('.ash-comment-highlight')!
      const badge = doc.querySelector<HTMLElement>(
        '.ash-comment-highlight-badge',
      )!
      const scroll = vi
        .spyOn(mark, 'scrollIntoView')
        .mockImplementation(() => {})
      const original = mark.firstChild as Text
      original.data = ''
      const excluded = doc.createElement('span')
      excluded.setAttribute('data-comment-ui', '')
      excluded.textContent = 'same'
      mark.appendChild(excluded)
      badge.parentNode!.insertBefore(
        doc.createTextNode('same'),
        badge.nextSibling,
      )
      // The region still contains canonical "same same" and the mark starts
      // at 5, but all four accepted characters now sit outside the mark.
      expect(mark.textContent).toBe('same')
      if (action === 'scroll') {
        frame!.contentWindow!.postMessage(
          {
            source: 'artifactshare-parent',
            kind: 'scroll-to-comment',
            threadId: 'u1',
          },
          '*',
        )
        await probeReporter()
      } else if (action === 'reapply') {
        await applyHighlights(highlights)
      } else {
        ;(action === 'mark' ? mark : badge).click()
        await probeReporter()
      }
      expect(scroll).not.toHaveBeenCalled()
      expect(mark.isConnected).toBe(false)
      expect(badge.isConnected).toBe(false)
      expect(selected()).toBeUndefined()
      if (action === 'reapply') {
        const current = doc.querySelector('.ash-comment-highlight')!
        expect(current.textContent).toBe('same')
        expect(current.querySelector('[data-comment-ui]')).toBeNull()
      } else {
        expect(doc.querySelector('.ash-comment-highlight')).toBeNull()
        expect(doc.querySelector('.ash-comment-highlight-badge')).toBeNull()
      }
    },
  )

  test('an identical highlights message preserves a selection inside the existing mark', async () => {
    const doc = await fixture('<p>Hello world</p>', true)
    const highlights = [{ threadId: 'u1', textStart: 6, textEnd: 11, count: 1 }]
    await applyHighlights(highlights)
    const mark = doc.querySelector('.ash-comment-highlight')!
    const text = mark.firstChild!
    const range = doc.createRange()
    range.setStart(text, 1)
    range.setEnd(text, 4)
    const selection = doc.getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)
    await applyHighlights(highlights)
    expect(doc.querySelector('.ash-comment-highlight')).toBe(mark)
    expect(selection.anchorNode).toBe(text)
    expect(selection.anchorOffset).toBe(1)
    expect(selection.focusNode).toBe(text)
    expect(selection.focusOffset).toBe(4)
    expect(selection.toString()).toBe('orl')
  })

  test.each(['mark', 'badge', 'layout', 'svg badge', 'svg layout'])(
    '%s invalidates stale highlights before interaction or measurement',
    async (action) => {
      const svg = action.startsWith('svg')
      const doc = await fixture(
        svg
          ? '<svg><text id="text" x="10" y="30">Hello world</text></svg>'
          : '<p id="text">Hello world</p>',
        true,
      )
      await applyHighlights(
        [{ threadId: 'u1', textStart: 6, textEnd: 11, count: 1 }],
        svg ? 0 : 1,
      )
      const mark = doc.querySelector<HTMLElement>('.ash-comment-highlight')
      const badge = doc.querySelector<HTMLButtonElement>(
        '.ash-comment-highlight-badge',
      )!
      expect(badge).not.toBeNull()
      if (svg) {
        expect(doc.querySelector('.ash-comment-highlight-svg')).not.toBeNull()
        const text = Array.from(doc.querySelector('#text')!.childNodes).find(
          (node) => node.nodeType === Node.TEXT_NODE,
        )!
        text.nodeValue = 'Hello other'
      } else mark!.firstChild!.nodeValue = 'other'
      if (action.includes('layout')) {
        frame!.contentWindow!.dispatchEvent(new Event('resize'))
        await vi.waitFor(() =>
          expect(doc.querySelector('.ash-comment-highlight-badge')).toBeNull(),
        )
      } else {
        ;(action === 'mark' ? mark! : badge).click()
      }
      expect(doc.querySelector('.ash-comment-highlight')).toBeNull()
      expect(doc.querySelector('.ash-comment-highlight-badge')).toBeNull()
      expect(doc.querySelector('.ash-comment-highlight-svg')).toBeNull()
      await probeReporter()
      expect(selected()).toBeUndefined()
      await applyHighlights(
        [{ threadId: 'u1', textStart: 6, textEnd: 11, count: 1 }],
        0,
      )
    },
  )

  test('equal-value script reconstruction during parsing preserves regions', async () => {
    const doc = await fixture(
      '<p id="text">Hello world</p><script>var p = document.getElementById("text"); p.innerHTML = p.innerHTML;</script>',
      true,
    )
    await applyHighlights([
      { threadId: 'u1', textStart: 6, textEnd: 11, count: 1 },
    ])
    expect(doc.querySelector('#text .ash-comment-highlight')?.textContent).toBe(
      'world',
    )
  })

  test.each(['selection', 'highlights', 'marker mismatch'])(
    '%s rechecks regions synchronously and clears existing highlights',
    async (action) => {
      const doc = await fixture('<p id="text">Hello world</p>', true)
      const highlights = [
        { threadId: 'u1', textStart: 6, textEnd: 11, count: 1 },
      ]
      await applyHighlights(highlights)
      if (action === 'marker mismatch')
        doc.querySelector('#text')!.firstChild!.remove()
      else
        doc.querySelector('.ash-comment-highlight')!.firstChild!.nodeValue =
          'other'
      // No await: the reporter must validate even before mutation observers run.
      if (action === 'selection') {
        const range = doc.createRange()
        range.selectNodeContents(doc.querySelector('#text')!)
        doc.getSelection()!.addRange(range)
        doc.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
        await vi.waitFor(() =>
          expect(doc.querySelector('.ash-comment-highlight')).toBeNull(),
        )
      } else {
        frame!.contentWindow!.dispatchEvent(
          new MessageEvent('message', {
            source: window,
            data: {
              source: 'artifactshare-parent',
              kind: 'comment-highlights',
              textAnchorsEnabled: true,
              highlights,
            },
          }),
        )
      }
      expect(doc.querySelector('.ash-comment-highlight')).toBeNull()
      expect(doc.querySelector('.ash-comment-highlight-badge')).toBeNull()
      await probeReporter()
      expect(
        messages.filter((message) => message.kind === 'text-selection'),
      ).toHaveLength(0)
      await applyHighlights(highlights, 0)
    },
  )

  test('text added outside source regions is not selectable and leaves source anchors usable', async () => {
    const doc = await fixture('<p id="text">Hello world</p>', true)
    const added = doc.createTextNode('Added words')
    doc.body.insertBefore(added, doc.body.firstChild)
    const range = doc.createRange()
    range.selectNodeContents(added)
    doc.getSelection()!.addRange(range)
    doc.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
    await waitForMessage('text-selection-cleared')
    expect(
      messages.filter((message) => message.kind === 'text-selection'),
    ).toHaveLength(0)
    await applyHighlights([
      { threadId: 'u1', textStart: 6, textEnd: 11, count: 1 },
    ])
    expect(doc.querySelector('#text .ash-comment-highlight')?.textContent).toBe(
      'world',
    )
    range.selectNodeContents(doc.querySelector('#text')!)
    doc.getSelection()!.removeAllRanges()
    doc.getSelection()!.addRange(range)
    doc.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
    expect((await waitForMessage('text-selection')).quotedText).toBe(
      'Hello world',
    )
  })

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
