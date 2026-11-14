// @vitest-environment happy-dom
import { createHash } from 'node:crypto'
import { afterEach, expect, test, vi } from 'vitest'
import { createReporterState } from '../../../../packages/viewer-kit/src/reporter/state.js'
import {
  elementTextIdentity,
  findElement,
  retainPreviewPick,
  trackPreviewPick,
} from '../../../../packages/viewer-kit/src/reporter/annotate.js'
import { textHash } from '../../../../packages/viewer-kit/src/reporter/text-hash.js'

afterEach(() => {
  document.body.innerHTML = ''
})

test.each(['\ud800', '\ud801', '\udc00', '\ufffd'])(
  'ambiguous oversized %j cannot attach even to its original selector',
  (suffix) => {
    const prefix = 'x'.repeat(16_001)
    document.body.innerHTML = '<p id="target"></p>'
    const target = document.querySelector('p')!
    const ctx = createReporterState(window)
    const legacyHash = createHash('sha256')
      .update(prefix + '\ufffd')
      .digest('hex')
    expect(textHash(prefix + suffix)).toBe(legacyHash)
    target.textContent = prefix + suffix
    expect(
      findElement(ctx, {
        kind: 'element',
        thread: 'synthetic-thread',
        selector: '#target',
        tagName: 'P',
        contextText: '',
        ownTextHash: legacyHash,
        ownTextExcerpt: prefix.slice(0, 16_000),
      }),
    ).toBeNull()
    // Healthy control uses the same DOM path and matching code.
    target.textContent = prefix + '😀'
    expect(
      findElement(ctx, {
        kind: 'element',
        thread: 'synthetic-thread',
        selector: '#target',
        tagName: 'P',
        contextText: '',
        ...elementTextIdentity(target.textContent),
      }),
    ).toBe(target)
  },
)

test.each(['hello', 'short \ufffd', 'x'.repeat(16_001), '😀'.repeat(8001)])(
  'unambiguous identities preserve UTF8 SHA256 and attachment (%#)',
  (text) => {
    document.body.innerHTML = '<p id="target"></p>'
    const target = document.querySelector('p')!
    target.textContent = text
    expect(textHash(text)).toBe(createHash('sha256').update(text).digest('hex'))
    expect(
      findElement(createReporterState(window), {
        kind: 'element',
        thread: 'synthetic-thread',
        selector: '#target',
        tagName: 'P',
        contextText: '',
        ...elementTextIdentity(text),
      }),
    ).toBe(target)
  },
)

test.each([15_998, 15_999, 16_000])(
  'excerpt does not cut a pair starting at %i',
  (offset) => {
    const text = 'x'.repeat(offset) + '😀rest'
    const identity = elementTextIdentity(text)
    expect(identity.ownTextExcerpt).toBe(
      text.slice(0, offset === 15_999 ? 15_999 : 16_000),
    )
    expect(identity.ownTextExcerpt!.length).toBeLessThanOrEqual(16_000)
    expect(
      new TextDecoder().decode(
        new TextEncoder().encode(identity.ownTextExcerpt),
      ),
    ).toBe(identity.ownTextExcerpt)
  },
)

test.each(['element', 'selection'])(
  'geometry follows only the accepted live %s pick and never its replacement',
  (kind) => {
    document.body.innerHTML = '<p id="target">Original</p><h1>Other</h1>'
    const target = document.querySelector('p')!
    const ctx = createReporterState(window)
    ctx.previewCapability = 'a'.repeat(64)
    ctx.previewSendSequence = 1
    const observations: Record<string, unknown>[] = []
    ctx.primordials.savedPostMessage = (_parent, message) => {
      observations.push(message)
    }
    let frame: FrameRequestCallback = () => {}
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      frame = callback
      return 1
    })
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {})
    let top = 720
    const range = document.createRange()
    range.selectNodeContents(target)
    const picked = kind === 'element' ? target : range
    vi.spyOn(picked, 'getBoundingClientRect').mockImplementation(
      () => ({ top, left: 0, width: 100, height: 20 }) as DOMRect,
    )
    try {
      retainPreviewPick(ctx, picked)
      trackPreviewPick(ctx, 1)
      expect(observations.at(-1)).toMatchObject({
        kind: 'annotation-geometry',
        pickSequence: 1,
        rect: { top: 720 },
      })
      retainPreviewPick(ctx, document.querySelector('h1')!)
      top = 268
      frame(0)
      expect(observations.at(-1)).toMatchObject({
        pickSequence: 1,
        rect: { top: 268 },
      })
      target.outerHTML = '<p id="target">Original</p>'
      frame(0)
      expect(observations.at(-1)).toMatchObject({ pickSequence: 1, rect: null })
      trackPreviewPick(ctx, null)
      const count = observations.length
      frame(0)
      expect(observations).toHaveLength(count)
    } finally {
      vi.restoreAllMocks()
    }
  },
)
