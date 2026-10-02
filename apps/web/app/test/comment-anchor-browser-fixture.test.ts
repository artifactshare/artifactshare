import { expect, test, vi } from 'vitest'
vi.mock('cloudflare:workers', () => ({ env: {} }))
import { commentAnchorRoundTrip } from './comment-anchor-browser-fixture'

test('browser bridge validates and returns the actual persisted anchor and server-resolved range', async () => {
  const result = await commentAnchorRoundTrip({
    source: '<p>Hello world</p><p>world</p>',
    nextSource: '<p>Look! Hello world</p><p>world</p>',
    anchor: {
      quotedText: 'world',
      prefixText: '',
      suffixText: '',
      textStart: 11,
      textEnd: 16,
      cssPath: null,
    },
  })
  expect(result.stored).toEqual({
    quoted_text: 'world',
    text_start: 11,
    text_end: 16,
  })
  expect(result.updated.subject).toMatchObject({
    state: 'attached',
    textStart: 17,
    textEnd: 22,
  })
})
