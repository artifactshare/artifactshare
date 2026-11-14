// @vitest-environment happy-dom
import { createHash } from 'node:crypto'
import { afterEach, expect, test } from 'vitest'
import { createReporterState } from '../../../../packages/viewer-kit/src/reporter/state.js'
import {
  elementTextIdentity,
  findElement,
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
