import { afterEach, expect, test, vi } from 'vitest'
import { commands } from 'vitest/browser'
import {
  VIOLATION_REPORTER_SCRIPT_BODY,
  type AnchorResolutionMessage,
  type TextSelectionMessage,
} from './csp-reporter'

type Message = TextSelectionMessage | AnchorResolutionMessage
let frame: HTMLIFrameElement
let messages: Message[] = []
function receive(event: MessageEvent<Message>) {
  if (event.source === frame?.contentWindow) messages.push(event.data)
}
function send(kind: string, fields: object = {}) {
  frame.contentWindow!.postMessage(
    {
      source: 'artifactshare-parent',
      kind,
      textAnchorsEnabled: true,
      versionId: 'synthetic-v1',
      targetPath: '/index.html',
      ...fields,
    },
    '*',
  )
}
async function fixture(html: string) {
  messages = []
  window.addEventListener('message', receive)
  frame = document.createElement('iframe')
  frame.id = 'anchor-reporter'
  frame.style.cssText = 'width:800px;height:600px;border:0'
  frame.srcdoc = `<!doctype html><body><main data-comment-content>${html}</main><script>${VIOLATION_REPORTER_SCRIPT_BODY}</script></body>`
  const loaded = new Promise<void>((resolve) =>
    frame.addEventListener('load', () => resolve(), { once: true }),
  )
  document.body.appendChild(frame)
  await loaded
  send('ready-check', { challenge: 'anchor-test' })
  await vi.waitFor(() =>
    expect(messages.some((m) => (m as { kind: string }).kind === 'ready')).toBe(
      true,
    ),
  )
  return frame.contentDocument!
}
async function selection() {
  await vi.waitFor(() =>
    expect(messages.some((m) => m.kind === 'text-selection')).toBe(true),
  )
  return messages.find(
    (m) => m.kind === 'text-selection',
  ) as TextSelectionMessage
}
function results() {
  return messages.filter((m) => m.kind === 'anchor-resolutions').at(-1) as
    | AnchorResolutionMessage
    | undefined
}
function registry(doc: Document) {
  return (
    doc.defaultView as unknown as {
      CSS: { highlights: Map<string, Set<Range>> }
    }
  ).CSS.highlights
}
afterEach(() => {
  window.removeEventListener('message', receive)
  frame?.remove()
})

const html = `<p id="ws">Spaced     text   with\n   line breaks inside it.</p><p id="tt" style="text-transform:uppercase">lowercase words shown upper</p><p id="hid">Visible start <span style="display:none">HIDDEN</span> visible end.</p><ul><li id="l1">List item one</li><li id="l2">List item two</li></ul>`
test.each([
  ['#ws', 0, '#ws', 36, 'Spaced text with line breaks'],
  ['#tt', 0, '#tt', 15, 'lowercase words'],
  ['#hid', 8, '#hid', 8, 'start visible'],
  ['#l1', 5, '#l2', 4, 'item one List'],
] as const)(
  'real mouse capture and paint: %s',
  async (start, startOffset, end, endOffset, quote) => {
    const doc = await fixture(html)
    // Raw whitespace offsets are read from the fixture, not rendered selection text.
    if (start === '#ws')
      endOffset = (doc.querySelector('#ws')!.textContent!.indexOf('breaks') +
        6) as typeof endOffset
    await commands.selectAnchorText(start, startOffset, end, endOffset)
    const selector = await selection()
    expect(selector.quotedText).toBe(quote)
    expect(selector.textEnd - selector.textStart).toBe(quote.length)
    const root = doc.querySelector('main')!
    const before = root.outerHTML
    const mutations: MutationRecord[] = []
    const observer = new MutationObserver((records) =>
      mutations.push(...records),
    )
    observer.observe(root, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
    })
    send('comment-highlights', {
      highlights: [{ ...selector, threadId: 'thread-1', count: 1 }],
    })
    await vi.waitFor(() =>
      expect(results()?.results[0]?.state).toBe('attached'),
    )
    const ranges = [...registry(doc).values()].flatMap((h) => [...h])
    expect(ranges.length).toBeGreaterThan(0)
    expect(
      ranges.every((r) => r.startContainer.parentElement!.checkVisibility()),
    ).toBe(true)
    expect(
      ranges.flatMap((r) => [...r.getClientRects()]).some((r) => r.width > 0),
    ).toBe(true)
    expect(ranges[0].startOffset).toBe(startOffset)
    expect(ranges.at(-1)!.endOffset).toBe(endOffset)
    expect(root.outerHTML).toBe(before)
    expect(mutations).toEqual([])
    expect(doc.querySelector('mark')).toBeNull()
    observer.disconnect()
  },
)

test('backward mouse selection uses ordered Range endpoints', async () => {
  await fixture(html)
  await commands.selectAnchorText('#l1', 5, '#l2', 4, true)
  expect((await selection()).quotedText).toBe('item one List')
})

test('mouse selection stays exact inside a scaled frame', async () => {
  const doc = await fixture(html)
  frame.style.transformOrigin = 'top left'
  frame.style.transform = 'scale(0.75)'
  await commands.selectAnchorText('#tt', 0, '#tt', 15)
  const range = doc.getSelection()!.getRangeAt(0)
  expect(range.startContainer).toBe(doc.querySelector('#tt')!.firstChild)
  expect(range.startOffset).toBe(0)
  expect(range.endContainer).toBe(range.startContainer)
  expect(range.endOffset).toBe(15)
  expect((await selection()).quotedText).toBe('lowercase words')
})

test('late rendering, same-text replacement, immediate invalidation and bounded checking', async () => {
  const doc = await fixture('<div id="late"></div>')
  send('comment-highlights', {
    highlights: [
      {
        threadId: 'late',
        quotedText: 'delayed words',
        prefixText: '',
        suffixText: '',
      },
    ],
  })
  await vi.waitFor(() => expect(results()?.results[0]?.state).toBe('checking'))
  setTimeout(() => {
    doc.querySelector('#late')!.textContent = 'delayed words'
  }, 500)
  await vi.waitFor(
    () => expect(results()?.results[0]?.state).toBe('attached'),
    { timeout: 2500 },
  )
  doc.querySelector('#late')!.textContent = 'delayed words'
  await vi.waitFor(() => {
    const ranges = [...registry(doc).values()].flatMap((h) => [...h])
    expect(ranges).toHaveLength(1)
    expect(ranges[0].startContainer).toBe(
      doc.querySelector('#late')!.firstChild,
    )
    expect(ranges[0].endOffset).toBe(13)
  })
  doc.querySelector('#late')!.textContent = 'rewritten'
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(registry(doc).size).toBe(0)
  expect(doc.querySelector('.ash-comment-highlight-badge')).toBeNull()
  await vi.waitFor(
    () => expect(results()?.results[0]?.state).toBe('needs-check'),
    { timeout: 3500 },
  )
  doc.querySelector('#late')!.textContent = 'delayed words'
  await vi.waitFor(() => expect(results()?.results[0]?.state).toBe('attached'))
  const count = messages.length
  await new Promise((resolve) => setTimeout(resolve, 400))
  expect(messages.length - count).toBeLessThan(5)
  send('comment-highlights', { highlights: [] })
  await vi.waitFor(() => expect(registry(doc).size).toBe(0))
})

test.each(['#selected', '#section', 'main'])(
  'changing anchor eligibility on %s immediately clears paint and restores it when eligible',
  async (target) => {
    const doc = await fixture(
      '<section id="section"><p id="selected">selected words</p></section>',
    )
    send('comment-highlights', {
      highlights: [
        {
          threadId: 'eligibility',
          quotedText: 'selected words',
          prefixText: '',
          suffixText: '',
        },
      ],
    })
    await vi.waitFor(() => {
      expect(results()?.results[0]?.state).toBe('attached')
      expect(registry(doc).size).toBeGreaterThan(0)
      expect(doc.querySelector('.ash-comment-highlight-badge')).not.toBeNull()
    })

    const element = doc.querySelector(target)!
    element.setAttribute('data-anchor-ignore', '')
    // Yield to mutation observers only: the 300 ms resolver timer cannot run yet.
    await new Promise<void>((resolve) => queueMicrotask(resolve))
    expect(registry(doc).size).toBe(0)
    expect(doc.querySelector('.ash-comment-highlight-badge')).toBeNull()

    element.removeAttribute('data-anchor-ignore')
    await vi.waitFor(() => {
      expect(registry(doc).size).toBeGreaterThan(0)
      expect(results()?.results[0]?.state).toBe('attached')
      const ranges = [...registry(doc).values()].flatMap((h) => [...h])
      expect(ranges).toHaveLength(1)
      expect(ranges[0].startContainer).toBe(
        doc.querySelector('#selected')!.firstChild,
      )
      expect(ranges[0].startOffset).toBe(0)
      expect(ranges[0].endOffset).toBe('selected words'.length)
    })
  },
)

test('omits paint safely without Custom Highlight support and retains badge navigation', async () => {
  const doc = await fixture('<p>unique words</p>')
  const css = (doc.defaultView as unknown as { CSS: object }).CSS
  Object.defineProperty(css, 'highlights', {
    configurable: true,
    value: undefined,
  })
  const before = doc.querySelector('main')!.outerHTML
  send('comment-highlights', {
    highlights: [
      {
        threadId: 'fallback',
        quotedText: 'unique words',
        prefixText: '',
        suffixText: '',
      },
    ],
  })
  await vi.waitFor(() =>
    expect(doc.querySelector('.ash-comment-highlight-badge')).not.toBeNull(),
  )
  expect(doc.querySelector('main')!.outerHTML).toBe(before)
  expect(doc.querySelector('mark')).toBeNull()
  const badge = doc.querySelector<HTMLButtonElement>(
    '.ash-comment-highlight-badge',
  )!
  badge.click()
  await vi.waitFor(() =>
    expect(
      messages.some(
        (message) =>
          (message as { kind: string }).kind === 'comment-thread-selected',
      ),
    ).toBe(true),
  )
})

test('SVG text retains glyph overlays and ignored badges on all three engines', async () => {
  const doc = await fixture(
    '<svg width="400" height="100"><text x="20" y="50">SVG words</text></svg>',
  )
  send('comment-highlights', {
    highlights: [
      {
        threadId: 'svg',
        quotedText: 'SVG words',
        prefixText: '',
        suffixText: '',
      },
    ],
  })
  await vi.waitFor(() => expect(results()?.results[0]?.state).toBe('attached'))
  await vi.waitFor(() =>
    expect(doc.querySelector('.ash-comment-highlight-svg')).not.toBeNull(),
  )
  expect(
    doc
      .querySelector('.ash-comment-highlight-svg')!
      .hasAttribute('data-anchor-ignore'),
  ).toBe(true)
  expect(
    doc
      .querySelector('.ash-comment-highlight-badge')!
      .hasAttribute('data-anchor-ignore'),
  ).toBe(true)
  expect(doc.querySelector('svg text')!.textContent).toBe('SVG words')
  expect(doc.querySelector('mark')).toBeNull()
})
