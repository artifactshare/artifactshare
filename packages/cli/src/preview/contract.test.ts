import { expect, test } from 'vitest'
import { isPreviewAnchor } from './contract.js'

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
