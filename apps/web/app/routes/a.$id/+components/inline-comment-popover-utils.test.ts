import { expect, test } from 'vitest'
import { withoutRect } from './inline-comment-popover-utils'

test('comment submission retains creation locus when removing selection geometry', () => {
  const locus = { headings: ['Teams', 'Training'], block_text: 'Alice Bob' }
  const anchor = {
    quotedText: 'Alice Bob',
    prefixText: '',
    suffixText: '',
    textStart: 0,
    textEnd: 9,
    cssPath: null,
    locus,
  }
  expect(
    withoutRect({
      ...anchor,
      rect: { top: 0, left: 0, width: 10, height: 10 },
    }),
  ).toMatchObject(anchor)
  expect(
    withoutRect({
      ...anchor,
      rect: { top: 0, left: 0, width: 10, height: 10 },
    }),
  ).not.toHaveProperty('rect')
})
