import { expect, test } from 'vitest'
import { isPreviewAnchor, isPreviewRewrite } from './contract.js'

const legacy = {
  kind: 'text',
  state: 'attached',
  quotedText: 'word',
  prefixText: '',
  suffixText: '',
  textStart: 0,
  textEnd: 4,
  cssPath: null,
}
const modern = {
  ...legacy,
  selectorFormat: 'normalized-v1',
  textHash: 'a'.repeat(64),
  ambiguousAtCreation: false,
  position_state: 'attached',
}
test('accepts legacy saved records and coherent modern selectors', () => {
  expect(isPreviewAnchor(legacy)).toBe(true)
  expect(isPreviewAnchor(modern)).toBe(true)
  expect(
    isPreviewAnchor({
      ...modern,
      state: 'orphaned',
      position_state: 'needs-check',
    }),
  ).toBe(true)
})
test.each([
  { textHash: undefined },
  { selectorFormat: 'future' },
  { ambiguousAtCreation: undefined },
  { textStart: NaN },
  { textEnd: 7 },
  { position_state: 'checking' },
  { prefixText: 'a'.repeat(401) },
])('rejects malformed selector metadata: %j', (patch) => {
  expect(isPreviewAnchor({ ...modern, ...patch })).toBe(false)
})

test.each([
  { quotedText: '', textEnd: 0 },
  { quotedText: 'x'.repeat(1500), textEnd: 1500 },
  { prefixText: 'x'.repeat(401) },
  { suffixText: 'x'.repeat(401) },
])(
  'length limits apply to new annotations, not stored legacy records: %j',
  (patch) => {
    expect(isPreviewAnchor({ ...legacy, ...patch })).toBe(false)
    expect(isPreviewAnchor({ ...legacy, ...patch }, { stored: true })).toBe(
      true,
    )
  },
)

test('element fingerprints require a complete pair without raw text; legacy text remains valid', () => {
  const base = {
    kind: 'element',
    state: 'attached',
    selector: 'p',
    label: 'p',
    contextText: '',
  }
  const hash = {
    ownTextHash: 'b'.repeat(64),
    ownTextExcerpt: 'x'.repeat(16000),
  }
  expect(isPreviewAnchor({ ...base, ...hash })).toBe(true)
  for (const patch of [
    { ownText: '' },
    { ownTextHash: 'bad' },
    { ownTextHash: undefined },
    { ownTextExcerpt: undefined },
    { ownTextExcerpt: 'x'.repeat(16001) },
  ]) {
    expect(isPreviewAnchor({ ...base, ...hash, ...patch })).toBe(false)
  }
  for (const ownText of ['', 'a'.repeat(64), 'x'.repeat(1_100_000)]) {
    expect(isPreviewAnchor({ ...base, ownText }, { stored: true })).toBe(true)
  }
  expect(isPreviewAnchor(base, { stored: true })).toBe(true)
})

test('anchors keep an optional bounded screen', () => {
  const element = {
    kind: 'element',
    state: 'attached',
    selector: 'h2',
    label: 'h2',
    contextText: 'Slide 2',
  }
  expect(isPreviewAnchor({ ...element, screen: '#/2' })).toBe(true)
  expect(isPreviewAnchor({ ...legacy, screen: '/settings' })).toBe(true)
  expect(isPreviewAnchor(element)).toBe(true)
  for (const screen of ['', 'x'.repeat(1001), 2, null])
    expect(isPreviewAnchor({ ...element, screen })).toBe(false)
})

test('rewrites are bounded and must change the text', () => {
  expect(isPreviewRewrite({ original: 'a', proposed: 'b' })).toBe(true)
  expect(isPreviewRewrite({ original: 'a', proposed: '' })).toBe(true)
  for (const value of [
    { original: 'a', proposed: 'a' },
    { original: '', proposed: 'b' },
    { original: 'a', proposed: 'b'.repeat(16001) },
    { original: 'a', proposed: 'b', extra: 1 },
    { original: 'a' },
    null,
  ])
    expect(isPreviewRewrite(value)).toBe(false)
})
