import { expect, test } from 'vitest'
import { validPreviewObservation } from './reporter-protocol.js'

const envelope = {
  source: 'artifactshare',
  previewCapability: 'a'.repeat(64),
  documentGeneration: 1,
  sequence: 1,
}
const element = {
  ...envelope,
  kind: 'element-annotate',
  selector: 'p',
  label: 'Text',
  contextText: '',
  ownText: 'Text',
  tagName: 'P',
  rect: { top: 0, left: 0, width: 20, height: 10 },
}
const selection = {
  ...envelope,
  kind: 'text-selection',
  token: 'b'.repeat(64),
  quotedText: 'Text',
  prefixText: '',
  suffixText: '',
  textStart: 0,
  textEnd: 4,
  selectorFormat: 'normalized-v1',
  textHash: 'c'.repeat(64),
  ambiguousAtCreation: false,
  versionId: null,
  cssPath: 'p',
  rect: element.rect,
}
const verdict = {
  ...envelope,
  kind: 'anchor-verdicts',
  verificationId: 1,
  generation: 1,
  verdicts: [{ thread: 'one', attached: true, position_state: 'attached' }],
}
const ready = {
  ...envelope,
  kind: 'ready',
  challenge: 'd'.repeat(64),
  token: 'e'.repeat(64),
}

test.each([element, selection, verdict, ready])(
  'admits a bounded observation and rejects missing/extra fields: $kind',
  (message) => {
    expect(validPreviewObservation(message)).toBe(true)
    expect(validPreviewObservation({ ...message, unexpected: true })).toBe(
      false,
    )
    for (const key of Object.keys(message)) {
      const missing: Record<string, unknown> = { ...message }
      delete missing[key]
      expect(validPreviewObservation(missing), key).toBe(false)
      expect(validPreviewObservation({ ...message, [key]: {} }), key).toBe(
        false,
      )
    }
  },
)
test.each([
  { ...element, selector: 'x'.repeat(4097) },
  { ...element, rect: { ...element.rect, top: Infinity } },
  { ...element, rect: { ...element.rect, left: 1_000_001 } },
  { ...element, rect: { ...element.rect, width: -1 } },
  { ...selection, textEnd: 3 },
  { ...selection, textStart: -1 },
  { ...selection, textHash: 'bad' },
  { ...selection, quotedText: 'x'.repeat(16385) },
  { ...verdict, verdicts: Array(1001).fill(verdict.verdicts[0]) },
  { ...verdict, verdicts: [verdict.verdicts[0], verdict.verdicts[0]] },
  { ...verdict, generation: NaN },
  { ...element, sequence: 0 },
  { ...element, sequence: Number.MAX_SAFE_INTEGER + 1 },
  { ...element, previewCapability: 'short' },
])('rejects malformed bounded observations %#', (message) => {
  expect(validPreviewObservation(message)).toBe(false)
})

test('accepts long element text while bounding the complete anchor text', () => {
  for (const length of [5000, 1_000_000]) {
    expect(
      validPreviewObservation({ ...element, ownText: 'x'.repeat(length) }),
    ).toBe(true)
  }
  expect(
    validPreviewObservation({ ...element, ownText: 'x'.repeat(1_000_001) }),
  ).toBe(false)
})

test('accepts selection observations with or without ignored optional locus', () => {
  expect(validPreviewObservation(selection)).toBe(true)
  for (const locus of [
    { headings: ['Teams', 'Training'], block_text: 'Text' },
    undefined,
    null,
    { headings: 1 },
  ]) {
    expect(validPreviewObservation({ ...selection, locus })).toBe(true)
    expect(
      validPreviewObservation({ ...selection, locus, unexpected: true }),
    ).toBe(false)
  }
})
