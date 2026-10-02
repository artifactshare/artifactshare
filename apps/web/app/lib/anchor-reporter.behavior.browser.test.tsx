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
  ['#hid', 8, '#hid', 8, 'start HIDDEN visible'],
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
    if (start === '#hid') {
      const hidden = ranges.find(
        (r) => r.startContainer === doc.querySelector('#hid span')!.firstChild,
      )!
      expect(hidden.startOffset).toBe(0)
      expect(hidden.endOffset).toBe(6)
      expect([...hidden.getClientRects()].some((rect) => rect.width > 0)).toBe(
        false,
      )
    }
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
  'eligibility attributes on %s wait for explicit resolution or content changes',
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
    const initialGeneration = results()!.generation
    const walk = vi.spyOn(doc, 'createTreeWalker')
    element.setAttribute('data-anchor-ignore', '')
    await new Promise((resolve) => setTimeout(resolve, 350))
    expect(walk).not.toHaveBeenCalled()
    expect(results()!.generation).toBe(initialGeneration)
    expect(registry(doc).size).toBe(1)

    // Structural exclusions still apply when a resolver is explicitly invoked.
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
      expect(results()?.results[0]?.state).toBe('checking')
      expect(registry(doc).size).toBe(0)
    })
    expect(doc.querySelector('.ash-comment-highlight-badge')).toBeNull()
    walk.mockClear()
    const ignoredGeneration = results()!.generation
    element.removeAttribute('data-anchor-ignore')
    await new Promise<void>((resolve) => queueMicrotask(resolve))
    expect(walk).not.toHaveBeenCalled()
    expect(results()!.generation).toBe(ignoredGeneration)
    expect(registry(doc).size).toBe(0)
    walk.mockRestore()

    // A subsequent content mutation picks up the current structural exclusions.
    doc.querySelector('#selected')!.textContent = 'selected words'
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

test.each([
  { selectorFormat: undefined, exact: true, duplicate: false, attached: true },
  { selectorFormat: undefined, exact: false, duplicate: false, attached: true },
  { selectorFormat: undefined, exact: false, duplicate: true, attached: false },
  { selectorFormat: 'quote-v1', exact: true, duplicate: false, attached: true },
  {
    selectorFormat: 'quote-v1',
    exact: false,
    duplicate: false,
    attached: true,
  },
  {
    selectorFormat: 'quote-v1',
    exact: false,
    duplicate: true,
    attached: false,
  },
  {
    selectorFormat: 'quote-v1',
    exact: true,
    duplicate: true,
    attached: false,
  },
])(
  'preview join tolerance applies to legacy and agent quotes and requires a unique position: %j',
  async ({ selectorFormat, exact, duplicate, attached }) => {
    await fixture(
      '<p>Hello the</p><p>selected words</p><p>here</p>' +
        (duplicate
          ? exact
            ? '<p>Hello the</p><p>selected words</p><p>here</p>'
            : '<p>Hello theselected wordshere</p>'
          : ''),
    )
    send('verify-anchors', {
      verificationId: 1,
      anchors: [
        {
          kind: 'text',
          thread: 'old-preview',
          selectorFormat,
          quotedText: 'selected words',
          prefixText: exact ? 'Hello the ' : 'Hello the',
          suffixText: exact ? ' here' : 'here',
          textStart: 999,
          textEnd: 1013,
        },
      ],
    })
    await vi.waitFor(
      () => {
        const verdict = (
          messages as unknown as { kind: string; verdicts?: unknown[] }[]
        ).findLast((m) => m.kind === 'anchor-verdicts')
        expect(verdict?.verdicts).toEqual([
          {
            thread: 'old-preview',
            attached,
            position_state: attached ? 'attached' : 'needs-check',
          },
        ])
      },
      { timeout: 6000 },
    )
  },
)

test('live counter preserves unrelated paint without hash-only messages', async () => {
  const doc = await fixture(
    '<p id="words">Stable selected words</p><p id="counter">0</p>',
  )
  send('comment-highlights', {
    highlights: [
      {
        threadId: 'stable',
        selectorFormat: 'quote-v1',
        quotedText: 'selected words',
        prefixText: '',
        suffixText: '',
      },
    ],
  })
  await vi.waitFor(() => expect(registry(doc).size).toBe(1))
  const initial = results()!.generation
  let count = 0
  const timer = setInterval(() => {
    doc.querySelector('#counter')!.textContent = String(++count)
  }, 100)
  try {
    for (let index = 0; index < 15; index++) {
      await new Promise((resolve) => setTimeout(resolve, 110))
      expect(registry(doc).size).toBe(1)
    }
    expect(results()!.generation).toBe(initial)
  } finally {
    clearInterval(timer)
  }
})

test('style animations and pages without comments do not rebuild text snapshots', async () => {
  const doc = await fixture('<p id="words">Stable selected words</p>')
  const walk = vi.spyOn(doc, 'createTreeWalker')
  doc.querySelector('#words')!.textContent = 'Stable selected words'
  await new Promise((resolve) => setTimeout(resolve, 50))
  expect(walk).not.toHaveBeenCalled()
  send('comment-highlights', {
    highlights: [
      {
        threadId: 'stable',
        quotedText: 'selected words',
        prefixText: '',
        suffixText: '',
      },
    ],
  })
  await vi.waitFor(() => expect(registry(doc).size).toBe(1))
  walk.mockClear()
  for (let index = 0; index < 5; index++) {
    doc.querySelector<HTMLElement>('#words')!.style.transform =
      `translateX(${index}px)`
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  expect(walk).not.toHaveBeenCalled()
  walk.mockRestore()
})

test('nested scrolling repositions the comment badge', async () => {
  const doc = await fixture(
    '<div id="scroll" style="height:150px;overflow:auto"><p id="words" style="margin-top:80px">Selected words</p><div style="height:800px"></div></div>',
  )
  send('comment-highlights', {
    highlights: [
      {
        threadId: 'scroll',
        quotedText: 'Selected words',
        prefixText: '',
        suffixText: '',
      },
    ],
  })
  await vi.waitFor(() =>
    expect(doc.querySelector('.ash-comment-highlight-badge')).not.toBeNull(),
  )
  const badge = doc.querySelector<HTMLElement>('.ash-comment-highlight-badge')!
  const top = badge.getBoundingClientRect().top
  doc.querySelector('#scroll')!.scrollTop = 50
  await vi.waitFor(() =>
    expect(badge.getBoundingClientRect().top).toBeCloseTo(top - 50, 0),
  )
})

test.each(['First', 'Second'])(
  'SVG indentation keeps %s overlays on the selected tspan',
  async (quote) => {
    const doc = await fixture(
      '<svg width="400" height="150"><text>\n  <tspan id="First" x="20" y="40">First</tspan>\n  <tspan id="Second" x="20" y="100">Second</tspan>\n</text></svg>',
    )
    const original = doc.querySelector('svg text')!.outerHTML
    send('comment-highlights', {
      highlights: [
        {
          threadId: 'svg-indent',
          quotedText: quote,
          prefixText: '',
          suffixText: '',
        },
      ],
    })
    await vi.waitFor(() =>
      expect(doc.querySelector('.ash-comment-highlight-svg')).not.toBeNull(),
    )
    const glyphs = doc.getElementById(quote)!.getBoundingClientRect()
    const overlays = doc.querySelectorAll('.ash-comment-highlight-svg')
    expect(overlays).toHaveLength(1)
    const overlay = overlays[0].getBoundingClientRect()
    // Glyph metrics differ by sub-pixel amounts across platforms; the tspans
    // are 60px apart, so 1.5px still proves the overlay is on the right one.
    const near = (actual: number, expected: number) =>
      expect(Math.abs(actual - expected)).toBeLessThanOrEqual(1.5)
    near(overlay.top, glyphs.top - 2)
    near(overlay.bottom, glyphs.bottom + 2)
    near(overlay.left, glyphs.left - 2)
    near(overlay.right, glyphs.right + 2)
    expect(doc.querySelector('svg text')!.outerHTML).toBe(original)
  },
)

test('resolution messages are chunked for more than 100 comments', async () => {
  await fixture('<p>Unique words</p>')
  send('comment-highlights', {
    highlights: Array.from({ length: 205 }, (_, index) => ({
      threadId: `thread-${index}`,
      quotedText: 'Unique words',
      prefixText: '',
      suffixText: '',
    })),
  })
  await vi.waitFor(() => {
    const batches = messages.filter(
      (m) => m.kind === 'anchor-resolutions',
    ) as AnchorResolutionMessage[]
    expect(batches.map((m) => m.results.length)).toEqual([100, 100, 5])
    expect(new Set(batches.map((m) => m.generation)).size).toBe(3)
  })
})

test.each([false, true])(
  'inserting text between painted pieces clears before debounce (queued: %s)',
  async (queued) => {
    const doc = await fixture('<p id="words">selected <b>bold</b> words</p>')
    send('comment-highlights', {
      highlights: [
        {
          threadId: 'pieces',
          quotedText: 'selected bold words',
          prefixText: '',
          suffixText: '',
        },
      ],
    })
    await vi.waitFor(() => expect(registry(doc).size).toBe(1))
    if (queued) {
      const first = doc.querySelector('#words')!.firstChild!
      first.nodeValue = 'selected '
      await new Promise<void>((resolve) => queueMicrotask(resolve))
    }
    const bold = doc.querySelector('b')!
    bold.parentNode!.insertBefore(doc.createTextNode('inserted '), bold)
    await new Promise<void>((resolve) => queueMicrotask(resolve))
    expect(registry(doc).size).toBe(0)
    expect(doc.querySelector('.ash-comment-highlight-badge')).toBeNull()
  },
)

test('class toggles cause no text rebuild or resolution message', async () => {
  const doc = await fixture('<p id="words">selected words</p>')
  send('comment-highlights', {
    highlights: [
      {
        threadId: 'stable',
        quotedText: 'selected words',
        prefixText: '',
        suffixText: '',
      },
    ],
  })
  await vi.waitFor(() => expect(registry(doc).size).toBe(1))
  const initial = messages.filter(
    (message) => message.kind === 'anchor-resolutions',
  ).length
  const walk = vi.spyOn(doc, 'createTreeWalker')
  for (let index = 0; index < 10; index++) {
    doc.querySelector('#words')!.className = `class-${index}`
    await new Promise<void>((resolve) => queueMicrotask(resolve))
  }
  await new Promise((resolve) => setTimeout(resolve, 100))
  expect(walk).not.toHaveBeenCalled()
  expect(
    messages.filter((message) => message.kind === 'anchor-resolutions'),
  ).toHaveLength(initial)
  walk.mockRestore()
})

test('animation-frame counters never clear unrelated highlight paint or badges', async () => {
  const doc = await fixture(
    '<p id="words">Stable selected words</p><p id="counter">0</p>',
  )
  send('comment-highlights', {
    highlights: [
      {
        threadId: 'animated',
        selectorFormat: 'quote-v1',
        quotedText: 'selected words',
        prefixText: '',
        suffixText: '',
      },
    ],
  })
  await vi.waitFor(() => expect(registry(doc).size).toBe(1))
  const win = doc.defaultView!
  let frameId = 0
  try {
    await new Promise<void>((resolve, reject) => {
      let count = 0
      function tick() {
        // Queue the page's next callback before the reporter queues its flush,
        // reproducing an animation that runs first in every frame.
        if (++count < 30) frameId = win.requestAnimationFrame(tick)
        doc.querySelector('#counter')!.textContent = String(count)
        queueMicrotask(() => {
          try {
            expect(registry(doc).size).toBe(1)
            expect(
              doc.querySelector('.ash-comment-highlight-badge'),
            ).not.toBeNull()
            if (count === 30) resolve()
          } catch (error) {
            reject(error)
          }
        })
      }
      frameId = win.requestAnimationFrame(tick)
    })
  } finally {
    win.cancelAnimationFrame(frameId)
  }
})

test('identical tab panels retain ranges in A through every visibility switch', async () => {
  const doc = await fixture(
    '<section id="a"><p id="words">The identical sentence.</p></section><section id="b" hidden><p>The identical sentence.</p></section>',
  )
  await commands.selectAnchorText('#words', 4, '#words', 13)
  const selector = await selection()
  send('comment-highlights', {
    highlights: [{ ...selector, threadId: 'tabs', count: 1 }],
  })
  await vi.waitFor(() => expect(results()?.results[0]?.state).toBe('attached'))
  const initial = results()!.generation
  const walk = vi.spyOn(doc, 'createTreeWalker')
  for (const hidden of [true, false, true, false]) {
    doc.querySelector<HTMLElement>('#a')!.hidden = hidden
    doc.querySelector<HTMLElement>('#b')!.hidden = !hidden
    await new Promise((resolve) => setTimeout(resolve, 350))
    expect(
      doc.querySelector<HTMLElement>('.ash-comment-highlight-badge')!.style
        .display,
    ).toBe(hidden ? 'none' : 'inline-flex')
    expect(results()!.generation).toBe(initial)
    expect(results()!.results[0].state).toBe('attached')
    const ranges = [...registry(doc).values()].flatMap((highlight) => [
      ...highlight,
    ])
    expect(ranges).toHaveLength(1)
    expect(ranges[0].startContainer).toBe(
      doc.querySelector('#words')!.firstChild,
    )
    expect(ranges[0].endContainer).toBe(doc.querySelector('#words')!.firstChild)
    expect(ranges[0].startOffset).toBe(4)
    expect(ranges[0].endOffset).toBe(13)
    expect([...ranges[0].getClientRects()].some((rect) => rect.width > 0)).toBe(
      !hidden,
    )
  }
  const badge = doc.querySelector<HTMLElement>('.ash-comment-highlight-badge')!
  const top = badge.getBoundingClientRect().top
  const [range] = [...registry(doc).values()].flatMap((highlight) => [
    ...highlight,
  ])
  const rangeTop = range.getClientRects()[0].top
  doc.querySelector<HTMLElement>('#a')!.style.paddingTop = '80px'
  // Padding also changes paragraph margin collapsing. Follow the actual text
  // displacement instead of assuming it equals the padding value.
  const displacement = range.getClientRects()[0].top - rangeTop
  expect(displacement).toBeGreaterThan(0)
  await vi.waitFor(() =>
    expect(badge.getBoundingClientRect().top).toBeCloseTo(top + displacement),
  )
  expect(walk).not.toHaveBeenCalled()
  walk.mockRestore()
})

test('ancestor tab classes reposition and hide badges without rebuilding text', async () => {
  const doc = await fixture(
    '<style>.tab-hidden{display:none}.tab-offset{padding-top:80px}</style><p id="words">selected words</p>',
  )
  const root = doc.querySelector('main')!
  const tab = doc.createElement('section')
  root.parentNode!.insertBefore(tab, root)
  tab.appendChild(root)
  send('comment-highlights', {
    highlights: [
      {
        threadId: 'ancestor-tab',
        selectorFormat: 'quote-v1',
        quotedText: 'selected words',
      },
    ],
  })
  await vi.waitFor(() => expect(results()?.results[0]?.state).toBe('attached'))
  const badge = doc.querySelector<HTMLElement>('.ash-comment-highlight-badge')!
  const top = badge.getBoundingClientRect().top
  const generation = results()!.generation
  const [range] = [...registry(doc).values()].flatMap((highlight) => [
    ...highlight,
  ])
  const rangeTop = range.getClientRects()[0].top
  const walk = vi.spyOn(doc, 'createTreeWalker')
  try {
    tab.className = 'tab-offset'
    const displacement = range.getClientRects()[0].top - rangeTop
    expect(displacement).toBeGreaterThan(0)
    await vi.waitFor(() =>
      expect(badge.getBoundingClientRect().top).toBeCloseTo(top + displacement),
    )
    tab.className = 'tab-hidden'
    await vi.waitFor(() => expect(badge.style.display).toBe('none'))
    tab.className = ''
    await vi.waitFor(() => {
      expect(badge.style.display).toBe('inline-flex')
      expect(badge.getBoundingClientRect().top).toBeCloseTo(top)
    })
    expect(doc.querySelector('.ash-comment-highlight-badge')).toBe(badge)
    expect(results()!.generation).toBe(generation)
    expect(walk).not.toHaveBeenCalled()
  } finally {
    walk.mockRestore()
  }
})

test('hash-only changes do not post another resolution, but shifted hints do', async () => {
  const doc = await fixture(
    '<p id="words">selected words</p><p id="counter">0</p>',
  )
  send('comment-highlights', {
    highlights: [
      {
        threadId: 'stable',
        selectorFormat: 'quote-v1',
        quotedText: 'selected words',
        prefixText: '',
        suffixText: '',
      },
    ],
  })
  await vi.waitFor(() => expect(results()?.results[0]?.state).toBe('attached'))
  const initial = results()!.generation
  doc.querySelector('#counter')!.textContent = '1'
  await new Promise((resolve) => setTimeout(resolve, 500))
  expect(results()!.generation).toBe(initial)
  expect(registry(doc).size).toBe(1)
  doc.querySelector('#words')!.prepend('intro ')
  await vi.waitFor(() => expect(results()!.generation).toBeGreaterThan(initial))
  expect(results()!.results[0]).toMatchObject({
    state: 'attached',
    textStart: 6,
    textEnd: 20,
  })
})

test.each(['normalized-v1', undefined])(
  'unrelated mutations retain paint across hidden inline text (%s)',
  async (selectorFormat) => {
    const doc = await fixture(
      '<p id="words">before selected<span style="display:none">HIDDEN</span>words after</p><p id="counter">0</p>',
    )
    await commands.selectAnchorText('#words', 7, '#words', 5)
    const selector = await selection()
    expect(selector.quotedText).toBe('selectedHIDDENwords')
    send('comment-highlights', {
      highlights: [
        {
          ...selector,
          selectorFormat,
          quotedText: selectorFormat
            ? selector.quotedText
            : '  selectedHIDDENwords\n',
          threadId: 'stable',
        },
      ],
    })
    await vi.waitFor(() => expect(registry(doc).size).toBe(1))
    const paint = [...registry(doc).values()][0]
    const badge = doc.querySelector('.ash-comment-highlight-badge')
    doc.querySelector<HTMLElement>('#words span')!.style.display = 'inline'
    doc.querySelector('#counter')!.textContent = '1'
    await new Promise<void>((resolve) => queueMicrotask(resolve))
    expect([...registry(doc).values()][0]).toBe(paint)
    expect(doc.querySelector('.ash-comment-highlight-badge')).toBe(badge)
  },
)

test('root replacement clears detached paint and resolves the new root', async () => {
  const doc = await fixture('<p>selected words</p>')
  send('comment-highlights', {
    highlights: [
      {
        selectorFormat: 'quote-v1',
        quotedText: 'selected words',
        threadId: 'root',
      },
    ],
  })
  await vi.waitFor(() => expect(registry(doc).size).toBe(1))
  const replacement = doc.createElement('main')
  replacement.setAttribute('data-comment-content', '')
  replacement.textContent = 'intro selected words'
  doc.querySelector('main')!.replaceWith(replacement)
  await new Promise<void>((resolve) => queueMicrotask(resolve))
  expect(registry(doc).size).toBe(0)
  await vi.waitFor(() => {
    const range = [...registry(doc).values()].flatMap((paint) => [...paint])[0]
    expect(range?.startContainer).toBe(replacement.firstChild)
    expect(range?.startOffset).toBe(6)
  })
})

test('outside-root mutations do not scan content or rebuild paint', async () => {
  const doc = await fixture('<p>selected words</p>')
  const outside = doc.createElement('aside')
  outside.textContent = 'counter 0'
  doc.body.appendChild(outside)
  send('comment-highlights', {
    highlights: [
      {
        selectorFormat: 'quote-v1',
        quotedText: 'selected words',
        threadId: 'inside',
      },
    ],
  })
  await vi.waitFor(() => expect(results()?.results[0]?.state).toBe('attached'))
  expect(registry(doc).size).toBe(1)
  const paint = [...registry(doc).values()][0]
  const badge = doc.querySelector('.ash-comment-highlight-badge')
  const generation = results()!.generation
  const walk = vi.spyOn(doc, 'createTreeWalker')
  try {
    for (let index = 1; index <= 3; index++) {
      outside.firstChild!.nodeValue = `counter ${index}`
      outside.className = `state-${index}`
      outside.appendChild(doc.createElement('span'))
      await new Promise<void>((resolve) => queueMicrotask(resolve))
    }
    // A child-list mutation on the root's parent is also unrelated unless the
    // selected root itself changes.
    doc.body.appendChild(doc.createElement('aside'))
    await new Promise((resolve) => setTimeout(resolve, 350))
    expect(walk).not.toHaveBeenCalled()
    expect([...registry(doc).values()][0]).toBe(paint)
    expect(doc.querySelector('.ash-comment-highlight-badge')).toBe(badge)
    expect(results()!.generation).toBe(generation)

    // Positive control: the same kind of mutation inside the root is observed.
    doc.querySelector('main')!.appendChild(doc.createTextNode(' inside edit'))
    await vi.waitFor(() => expect(walk).toHaveBeenCalled())
  } finally {
    walk.mockRestore()
  }
})

test('jump reveals a quote in plain-text code inside a horizontal scroller', async () => {
  const doc = await fixture(
    '<pre id="scroller" style="width:200px;overflow:auto"><code>' +
      'padding '.repeat(100) +
      'far right quote</code></pre>',
  )
  send('comment-highlights', {
    highlights: [
      {
        threadId: 'right',
        quotedText: 'far right quote',
        prefixText: '',
        suffixText: '',
      },
    ],
  })
  await vi.waitFor(() => expect(results()?.results[0]?.state).toBe('attached'))
  const scroller = doc.querySelector('#scroller')!
  expect(scroller.scrollLeft).toBe(0)
  send('scroll-to-comment', { threadId: 'right' })
  await vi.waitFor(() => expect(scroller.scrollLeft).toBeGreaterThan(0))
  const source = doc.querySelector('code')!
  expect(source.childNodes).toHaveLength(1)
  const painted = [...registry(doc).values()][0]!
  const range = [...painted][0]!
  expect(range.startContainer).toBe(source.firstChild)
  const rect = range.getBoundingClientRect()
  const container = scroller.getBoundingClientRect()
  expect(rect.left).toBeGreaterThanOrEqual(container.left)
  expect(rect.right).toBeLessThanOrEqual(container.right + 1)
})

test('resolved overlap retains its verdict but hides paint and badge until the open thread is gone', async () => {
  const doc = await fixture('<p>prefix selected words suffix</p>')
  const resolved = {
    threadId: 'done',
    status: 'resolved',
    quotedText: 'selected words',
    prefixText: '',
    suffixText: '',
  }
  send('comment-highlights', {
    highlights: [
      resolved,
      { ...resolved, threadId: 'open', status: 'open', quotedText: 'words' },
    ],
  })
  await vi.waitFor(() => expect(results()?.results).toHaveLength(2))
  expect(results()?.results.every((r) => r.state === 'attached')).toBe(true)
  expect(doc.querySelectorAll('.ash-comment-highlight-badge')).toHaveLength(1)
  expect(
    doc
      .querySelector('.ash-comment-highlight-badge')
      ?.getAttribute('data-thread-id'),
  ).toBe('open')
  expect(registry(doc).size).toBe(1)
  send('comment-highlights', { highlights: [resolved] })
  await vi.waitFor(() =>
    expect(
      doc
        .querySelector('.ash-comment-highlight-badge')
        ?.getAttribute('data-thread-id'),
    ).toBe('done'),
  )
})

test.each(['pre', 'p', 'div', 'td'])(
  'jump reveals a quote near the end of a tall plain-text %s without changing content',
  async (tag) => {
    const block = `<${tag} id="target" style="white-space:pre;margin:0;line-height:20px">${'padding line\n'.repeat(150)}quote near the end</${tag}>`
    const doc = await fixture(
      `<div id="scroller" style="height:140px;overflow:auto;margin-top:900px">${tag === 'td' ? `<table><tbody><tr>${block}</tr></tbody></table>` : block}</div>`,
    )
    const content = doc.querySelector('main')!
    const original = content.outerHTML
    const source = doc.querySelector('#target')!
    expect(source.childNodes).toHaveLength(1)
    send('comment-highlights', {
      highlights: [
        {
          threadId: 'bottom',
          quotedText: 'quote near the end',
          prefixText: '',
          suffixText: '',
        },
      ],
    })
    await vi.waitFor(() =>
      expect(results()?.results[0]?.state).toBe('attached'),
    )
    const range = [...[...registry(doc).values()][0]!][0]!
    expect(range.startContainer).toBe(source.firstChild)
    const scroller = doc.querySelector('#scroller')!
    expect(range.getBoundingClientRect().top).toBeGreaterThan(
      scroller.getBoundingClientRect().bottom,
    )
    send('scroll-to-comment', { threadId: 'bottom' })
    await vi.waitFor(() => {
      const rect = range.getBoundingClientRect()
      const viewport = scroller.getBoundingClientRect()
      expect(scroller.scrollTop).toBeGreaterThan(0)
      expect(rect.top).toBeGreaterThanOrEqual(viewport.top)
      expect(rect.bottom).toBeLessThanOrEqual(viewport.bottom + 1)
      expect(rect.top).toBeGreaterThanOrEqual(0)
      expect(rect.bottom).toBeLessThanOrEqual(doc.documentElement.clientHeight)
    })
    expect(content.outerHTML).toBe(original)
  },
)
