import { MAX_COMMENT_PAGE_NUMBER } from '@artifactshare/contract'
import { expect, test } from 'vitest'
import { isPdfPageNumber } from './comments'

test('accepts exactly 1 through the contract maximum page number', () => {
  expect(isPdfPageNumber(1)).toBe(true)
  expect(isPdfPageNumber(MAX_COMMENT_PAGE_NUMBER)).toBe(true)
  expect(isPdfPageNumber(0)).toBe(false)
  expect(isPdfPageNumber(MAX_COMMENT_PAGE_NUMBER + 1)).toBe(false)
  expect(isPdfPageNumber(1.5)).toBe(false)
  expect(isPdfPageNumber('1')).toBe(false)
})
