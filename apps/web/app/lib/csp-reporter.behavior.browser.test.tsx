import { afterEach, describe, expect, test, vi } from 'vitest'
import { page, server, userEvent } from 'vitest/browser'
import { VIOLATION_REPORTER_SCRIPT_BODY } from './csp-reporter'
import { renderMermaidSvg, sanitizeMermaidSvg } from './mermaid-render.client'
import {
  buildPrintDocument,
  resolveExportHtml,
} from '../routes/a.$id/+components/export-actions'

type ReporterMessage = { kind?: string; [key: string]: unknown }

let frame: HTMLIFrameElement | undefined
let messages: ReporterMessage[] = []
let readyEvents: MessageEvent<ReporterMessage>[] = []
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
  for (let attempt = 0; attempt < 3; attempt += 1) {
    frame!.contentWindow!.postMessage(
      {
        source: 'artifactshare-parent',
        kind: 'ready-check',
        challenge: probe,
        textAnchorsEnabled: true,
      },
      '*',
    )
    try {
      // Poll only for the reply. Retry only after this attempt times out,
      // never on every assertion poll while a reply is still in flight.
      await vi.waitFor(
        () => {
          expect(
            messages
              .slice(firstResponseIndex)
              .some(
                (message) =>
                  message.kind === 'ready' &&
                  message.challenge === probe &&
                  typeof message.token === 'string',
              ),
          ).toBe(true)
        },
        { timeout: 1000 },
      )
      return
    } catch (error) {
      if (attempt === 2) throw error
    }
  }
}

async function fixture(
  body = '<a id="normal" href="?artifact-link=1">Normal link</a><a id="target" href="?artifact-link=1">Highlighted text</a>',
) {
  messages = []
  readyEvents = []
  window.addEventListener('message', onMessage)
  frame?.remove()
  frame = document.createElement('iframe')
  frame.style.cssText = 'width:800px;height:600px;border:0'
  frame.srcdoc = `<!doctype html><body style="margin:40px;background:white"><div id="content">${body}</div><script>${VIOLATION_REPORTER_SCRIPT_BODY}</script></body>`
  const loaded = new Promise<void>((resolve) =>
    frame?.addEventListener('load', () => resolve(), { once: true }),
  )
  document.body.appendChild(frame)
  await loaded
  await probeReporter()
  return frame.contentDocument!
}

function onMessage(event: MessageEvent<ReporterMessage>) {
  if (event.data?.source === 'artifactshare' && event.data.kind === 'ready')
    readyEvents.push(event)
  if (event.source === frame?.contentWindow) messages.push(event.data)
}

async function applyHighlights(highlights: unknown[]) {
  frame!.contentWindow!.postMessage(
    {
      source: 'artifactshare-parent',
      kind: 'comment-highlights',
      textAnchorsEnabled: true,
      highlights: highlights.map((h) => ({
        quotedText: 'Highlighted text',
        prefixText: '',
        suffixText: '',
        ...(h as object),
      })),
    },
    '*',
  )
  await probeReporter()
  await vi.waitFor(() =>
    expect(
      frame!.contentDocument!.querySelectorAll('.ash-comment-highlight-badge'),
    ).toHaveLength(highlights.length),
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
  test('readiness replies identify the artifact frame as their sender', async () => {
    await fixture('<p>Frame identity</p>')
    const challenge = 'frame-identity-probe'
    await probeReporter(challenge)
    const reply = readyEvents.find(
      (event) => event.data.challenge === challenge,
    )!
    expect(reply).toBeDefined()
    expect(reply.source).toBe(frame!.contentWindow)
    expect(reply.data.token).toMatch(/^[a-f0-9]{64}$/)
  })

  test('waits for an in-flight probe reply without sending duplicate checks', async () => {
    const doc = await fixture(`<script>
      let delayed = false;
      let checks = 0;
      window.addEventListener('message', function delayProbe(event) {
        if (event.data?.kind !== 'ready-check') return;
        if (delayed) { delayed = false; return; }
        document.body.dataset.probeCount = String(++checks);
        event.stopImmediatePropagation();
        setTimeout(() => {
          delayed = true;
          window.dispatchEvent(new MessageEvent('message', {
            data: event.data, source: event.source, origin: event.origin
          }));
        }, 150);
      }, true);
    </script><p>Delayed reply</p>`)
    expect(doc.body.dataset.probeCount).toBe('1')
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

    frame!.contentWindow!.postMessage(
      {
        source: 'artifactshare-parent',
        kind: 'comment-highlights',
        highlights: [
          {
            threadId: 'mermaid-source',
            quotedText: source,
            prefixText: '',
            suffixText: '',
          },
        ],
      },
      '*',
    )
    const resolution = await waitForMessage('anchor-resolutions')
    expect(resolution.results).toEqual([
      expect.objectContaining({
        threadId: 'mermaid-source',
        state: 'attached',
      }),
    ])
    expect(doc.querySelector('mark')).toBeNull()
    const badge = doc.querySelector<HTMLElement>(
      '.ash-comment-highlight-badge',
    )!
    expect(badge).not.toBeNull()
    expect(badge.style.display).toBe('none')
    const registry = (
      doc.defaultView as unknown as {
        CSS: { highlights: Map<string, Set<Range>> }
      }
    ).CSS.highlights
    const ranges = [...registry.values()].flatMap((highlight) => [...highlight])
    expect(ranges).toHaveLength(1)
    expect(ranges[0].startContainer).toBe(
      doc.querySelector('pre code')!.firstChild,
    )
    expect(ranges[0].endContainer).toBe(ranges[0].startContainer)
    expect(ranges[0].startOffset).toBe(0)
    expect(ranges[0].endOffset).toBe(source.length)
    expect([...ranges[0].getClientRects()].some((rect) => rect.width > 0)).toBe(
      false,
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

  test('keyboard link activation and script clicks ignore highlight geometry at the origin', async () => {
    const doc = await fixture(
      '<p style="position:fixed;left:0;top:0;margin:0">Highlighted text</p><a id="link" href="https://example.com/keyboard-target">Go</a><form><button id="submit">Submit</button></form>',
    )
    await applyHighlights([{ threadId: 'thread-1' }])
    // Make the source range cover (0,0), including browsers with font ascenders.
    const rangePrototype = Object.getPrototypeOf(doc.createRange())
    const getRects = rangePrototype.getClientRects
    rangePrototype.getClientRects = () => [
      { left: 0, top: 0, right: 200, bottom: 30, width: 200, height: 30 },
    ]
    try {
      let submitted = false
      doc.querySelector('form')!.addEventListener('submit', (event) => {
        event.preventDefault()
        submitted = true
      })
      // Establish browser focus inside the iframe before sending real keys.
      // Programmatic element focus alone can leave Firefox's keyboard input
      // directed at the enclosing tester frame.
      const reporter = page.frameLocator(page.elementLocator(frame!))
      await reporter.getByRole('button', { name: 'Submit' }).click()
      submitted = false
      doc.querySelector<HTMLButtonElement>('#submit')!.click()
      expect(submitted).toBe(true)
      const link = doc.querySelector<HTMLAnchorElement>('#link')!
      link.focus()
      expect(doc.activeElement).toBe(link)
      expect(document.activeElement).toBe(frame)
      await userEvent.keyboard('{Enter}')
      // A srcdoc fragment link inherits the runner URL and would load a second
      // Vitest tester. Exercise the normal parent-link gate without navigation.
      await waitForMessage(
        'link-clicked',
        (message) => message.href === 'https://example.com/keyboard-target',
      )
      expect(frame!.contentDocument).toBe(doc)
      await probeReporter()
      expect(selected()).toBeUndefined()
    } finally {
      rangePrototype.getClientRects = getRects
    }
  })

  test('a focused badge survives live counter changes and equal-value node replacement', async () => {
    const doc = await fixture(
      '<p id="target">Highlighted text</p><p id="counter">0</p>',
    )
    await applyHighlights([{ threadId: 'thread-1' }])
    const badge = doc.querySelector<HTMLButtonElement>(
      '.ash-comment-highlight-badge',
    )!
    badge.focus()
    doc.querySelector('#counter')!.textContent = '1'
    await new Promise((resolve) => setTimeout(resolve, 400))
    expect(doc.querySelector('.ash-comment-highlight-badge')).toBe(badge)
    expect(doc.activeElement).toBe(badge)
    doc.querySelector('#target')!.textContent = 'Highlighted text'
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(doc.querySelector('.ash-comment-highlight-badge')).toBe(badge)
    expect(doc.activeElement).toBe(badge)
  })

  test('reattachment renews the checking grace for hosted and preview anchors', async () => {
    const doc = await fixture('<p id="target">Missing</p>')
    const post = (kind: string, data: object) =>
      frame!.contentWindow!.postMessage(
        { source: 'artifactshare-parent', kind, ...data },
        '*',
      )
    post('comment-highlights', {
      textAnchorsEnabled: true,
      highlights: [
        {
          threadId: 'hosted',
          quotedText: 'Highlighted text',
          prefixText: '',
          suffixText: '',
        },
      ],
    })
    post('verify-anchors', {
      anchors: [
        {
          kind: 'text',
          thread: 'preview',
          quotedText: 'Highlighted text',
          prefixText: '',
          suffixText: '',
        },
      ],
    })
    const hasState = (kind: string, state: string, from = 0) =>
      vi.waitFor(
        () => {
          expect(
            messages
              .slice(from)
              .some(
                (message) =>
                  message.kind === kind &&
                  JSON.stringify(message).includes('"' + state + '"'),
              ),
          ).toBe(true)
        },
        { timeout: 4200 },
      )
    await hasState('anchor-resolutions', 'needs-check')
    await hasState('anchor-verdicts', 'needs-check')
    let from = messages.length
    doc.querySelector('#target')!.textContent = 'Highlighted text'
    await hasState('anchor-resolutions', 'attached', from)
    await hasState('anchor-verdicts', 'attached', from)
    from = messages.length
    doc.querySelector('#target')!.textContent = 'Missing again'
    await hasState('anchor-resolutions', 'checking', from)
    await hasState('anchor-verdicts', 'checking', from)
    await hasState('anchor-resolutions', 'needs-check', from)
    await hasState('anchor-verdicts', 'needs-check', from)
  }, 12000)

  test('keyboard operation on a comment badge sends selection to the parent', async () => {
    const doc = await fixture(
      '<button id=before>Before comments</button><p>Highlighted text</p>',
    )
    await applyHighlights([
      { threadId: 'thread-1', textStart: 0, textEnd: 16, count: 1 },
    ])
    const badge = doc.querySelector<HTMLButtonElement>(
      '.ash-comment-highlight-badge',
    )!
    // Start before the badge in the frame's sequential focus order.
    // WebKit on macOS does not focus buttons on mouse click.
    const before = doc.querySelector<HTMLButtonElement>('#before')!
    before.focus()
    expect(doc.activeElement).toBe(before)
    // macOS WebKit uses Option+Tab to include buttons in keyboard navigation.
    if (server.browser === 'webkit' && server.platform === 'darwin') {
      await userEvent.keyboard('{Alt>}{Tab}{/Alt}')
    } else {
      await userEvent.tab()
    }
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
    await fixture()
    await applyHighlights([
      { threadId: 'thread-3', textStart: 11, textEnd: 27, count: 1 },
    ])
    const reporter = page.frameLocator(page.elementLocator(frame!))
    await reporter.getByText('Highlighted text', { exact: true }).click()
    await reporter.getByLabelText('Open 1 unresolved comment on').click()
    await probeReporter()
    expect(
      messages.filter(
        (message) => message.kind === 'comment-outside-pointer-down',
      ),
    ).toHaveLength(0)

    await reporter.getByText('Normal link', { exact: true }).click()
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
    const lightStyle = light.querySelector(
      '#ash-comment-highlight-style',
    )!.textContent!
    const dark = await fixture(
      '<p id="text" style="background:rgb(0,0,0)">Highlighted text</p>',
    )
    await applyHighlights([
      { threadId: 'dark', textStart: 0, textEnd: 16, count: 1 },
    ])
    const darkStyle = dark.querySelector(
      '#ash-comment-highlight-style',
    )!.textContent!
    expect(lightStyle).not.toBe(darkStyle)
    expect(lightStyle.replaceAll(' ', '')).toContain(
      'background-color:rgba(37,99,235,.16)',
    )
    expect(darkStyle.replaceAll(' ', '')).toContain(
      'background-color:rgba(96,165,250,.16)',
    )
  })

  test('badge position is updated from the highlight client rect', async () => {
    const doc = await fixture('<p>Highlighted text</p>')
    await applyHighlights([
      { threadId: 'position', textStart: 0, textEnd: 16, count: 1 },
    ])
    const mark = doc.createRange()
    mark.selectNodeContents(doc.querySelector('p')!)
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

  test.each([
    { visibility: 'hidden', display: 'inline' },
    { visibility: 'collapse', display: 'inline' },
    { visibility: 'hidden', display: 'contents' },
    { visibility: 'collapse', display: 'contents' },
  ])(
    'badge follows ancestor visibility:$visibility with display:$display without rebuilding anchors',
    async ({ visibility, display }) => {
      const doc = await fixture(
        `<style>.concealed { visibility: ${visibility}; }</style><section><p><span style="display:${display}"><span style="display:${display}">Highlighted text</span></span></p></section>`,
      )
      await applyHighlights([{ threadId: 'visibility', count: 1 }])
      const ancestor = doc.querySelector('section')!
      const badge = doc.querySelector<HTMLElement>(
        '.ash-comment-highlight-badge',
      )!
      const registry = (
        doc.defaultView as unknown as {
          CSS: { highlights: Map<string, Set<Range>> }
        }
      ).CSS.highlights
      const originalHighlights = [...registry.values()]
      expect(originalHighlights).toHaveLength(1)
      await vi.waitFor(() => expect(badge.style.display).toBe('inline-flex'))
      const messageCount = messages.filter(
        (message) => message.kind === 'anchor-resolutions',
      ).length

      ancestor.classList.add('concealed')
      await vi.waitFor(() => expect(badge.style.display).toBe('none'))
      expect([...registry.values()][0]).toBe(originalHighlights[0])

      // Re-resolution must reuse the badge and still refresh its geometry.
      await applyHighlights([{ threadId: 'visibility', count: 1 }])
      expect(doc.querySelector('.ash-comment-highlight-badge')).toBe(badge)
      expect(badge.style.display).toBe('none')
      const refreshedHighlight = [...registry.values()][0]

      ancestor.classList.remove('concealed')
      await vi.waitFor(() => expect(badge.style.display).toBe('inline-flex'))
      expect(doc.querySelector('.ash-comment-highlight-badge')).toBe(badge)
      expect([...registry.values()][0]).toBe(refreshedHighlight)
      expect(
        messages.filter((message) => message.kind === 'anchor-resolutions'),
      ).toHaveLength(messageCount)

      const range = [...refreshedHighlight][0]
      const rect = range.getBoundingClientRect()
      expect(rect.width).toBeGreaterThan(0)
      range.startContainer.parentElement!.dispatchEvent(
        new MouseEvent('click', {
          bubbles: true,
          cancelable: true,
          detail: 1,
          clientX: rect.left + rect.width / 2,
          clientY: rect.top + rect.height / 2,
        }),
      )
      await probeReporter()
      expect(selected()).toBeUndefined()
      // Only trusted pointer input may select text highlights. Keep the
      // synthetic click above as a negative control even with detail > 0.
      const reporter = page.frameLocator(page.elementLocator(frame!))
      // display:contents spans have no actionable box. The paragraph owns
      // the text's layout box; clicking it still exercises range hit testing.
      const paragraphRect = doc.querySelector('p')!.getBoundingClientRect()
      await reporter.getByRole('paragraph').click({
        position: {
          x: rect.left + rect.width / 2 - paragraphRect.left,
          y: rect.top + rect.height / 2 - paragraphRect.top,
        },
      })
      await waitForMessage(
        'comment-thread-selected',
        (message) => message.threadId === 'visibility',
      )
      messages = []
      await reporter.getByRole('button').click()
      await waitForMessage(
        'comment-thread-selected',
        (message) => message.threadId === 'visibility',
      )
    },
  )

  test.each(['html', 'svg'])(
    '%s badge follows the last range visibility and reappears without rebuilding anchors',
    async (kind) => {
      const content =
        kind === 'svg'
          ? '<svg width="400" height="100"><text x="10" y="40"><tspan id="first">Highlighted </tspan><tspan id="last">text</tspan></text></svg>'
          : '<p><span id="first">Highlighted </span><span id="last">text</span></p>'
      const doc = await fixture(content)
      await applyHighlights([{ threadId: 'last-range', count: 1 }])
      const badge = doc.querySelector<HTMLElement>(
        '.ash-comment-highlight-badge',
      )!
      const first = doc.getElementById('first')!
      const last = doc.getElementById('last')!
      const overlays = Array.from(
        doc.querySelectorAll<SVGElement>('.ash-comment-highlight-svg'),
      )
      if (kind === 'svg') expect(overlays).toHaveLength(2)
      const expectOverlayVisibility = (
        firstVisible: boolean,
        lastVisible: boolean,
      ) => {
        if (kind !== 'svg') return
        expect(doc.defaultView!.getComputedStyle(overlays[0]).display).toBe(
          firstVisible ? 'inline' : 'none',
        )
        expect(doc.defaultView!.getComputedStyle(overlays[1]).display).toBe(
          lastVisible ? 'inline' : 'none',
        )
      }
      expectOverlayVisibility(true, true)
      await vi.waitFor(() => expect(badge.style.display).toBe('inline-flex'))
      const messageCount = messages.filter(
        (message) => message.kind === 'anchor-resolutions',
      ).length

      // The badge stays on the visible end even if the beginning is hidden.
      first.style.visibility = 'hidden'
      await new Promise<void>((resolve) =>
        frame!.contentWindow!.requestAnimationFrame(() =>
          frame!.contentWindow!.requestAnimationFrame(() => resolve()),
        ),
      )
      await vi.waitFor(() => {
        expect(badge.style.display).toBe('inline-flex')
        const endRect = last.getBoundingClientRect()
        expect(
          Math.abs(badge.getBoundingClientRect().left - (endRect.right - 6)),
        ).toBeLessThan(2)
      })
      expectOverlayVisibility(false, true)
      first.style.visibility = 'visible'
      last.style.visibility = 'hidden'
      await vi.waitFor(() => {
        expect(badge.style.display).toBe('none')
        expectOverlayVisibility(true, false)
      })

      last.style.visibility = 'visible'
      await vi.waitFor(() => {
        expect(badge.style.display).toBe('inline-flex')
        expectOverlayVisibility(true, true)
      })
      expect(
        Array.from(doc.querySelectorAll('.ash-comment-highlight-svg')),
      ).toEqual(overlays)
      expect(doc.querySelector('.ash-comment-highlight-badge')).toBe(badge)
      expect(
        messages.filter((message) => message.kind === 'anchor-resolutions'),
      ).toHaveLength(messageCount)
    },
  )

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

test('a covered resolved comment retains verified ranges for jump without painting', async () => {
  const doc = await fixture(
    '<div style="height:1800px"></div><p id="covered">Highlighted text</p>',
  )
  frame!.contentWindow!.postMessage(
    {
      source: 'artifactshare-parent',
      kind: 'comment-highlights',
      textAnchorsEnabled: true,
      highlights: ['open', 'resolved'].map((status) => ({
        threadId: status,
        status,
        quotedText: 'Highlighted text',
        prefixText: '',
        suffixText: '',
      })),
    },
    '*',
  )
  const result = await waitForMessage('anchor-resolutions')
  expect(result.results).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ threadId: 'resolved', state: 'attached' }),
    ]),
  )
  expect(doc.querySelectorAll('.ash-comment-highlight-badge')).toHaveLength(1)
  expect(doc.querySelector('[data-thread-id="resolved"]')).toBeNull()
  expect(
    doc.getElementById('covered')!.getBoundingClientRect().top,
  ).toBeGreaterThan(600)
  frame!.contentWindow!.postMessage(
    {
      source: 'artifactshare-parent',
      kind: 'scroll-to-comment',
      threadId: 'resolved',
    },
    '*',
  )
  await vi.waitFor(() => {
    const rect = doc.getElementById('covered')!.getBoundingClientRect()
    expect(rect.top).toBeGreaterThanOrEqual(0)
    expect(rect.bottom).toBeLessThanOrEqual(600)
  })
  expect(doc.querySelector('[data-thread-id="resolved"]')).toBeNull()
})
