import { MAX_COMMENT_PAGE_NUMBER as CONTRACT_MAX_COMMENT_PAGE_NUMBER } from '@artifactshare/contract'
import { describe, expect, test } from 'vitest'
import { isPdfPageNumber, MAX_COMMENT_PAGE_NUMBER } from './comments'

describe('comment page-number range', () => {
  test('matches the contract the CLI and MCP parse against', () => {
    expect(MAX_COMMENT_PAGE_NUMBER).toBe(CONTRACT_MAX_COMMENT_PAGE_NUMBER)
  })

  test('accepts exactly 1 through the shared maximum', () => {
    expect(isPdfPageNumber(1)).toBe(true)
    expect(isPdfPageNumber(MAX_COMMENT_PAGE_NUMBER)).toBe(true)
    expect(isPdfPageNumber(0)).toBe(false)
    expect(isPdfPageNumber(MAX_COMMENT_PAGE_NUMBER + 1)).toBe(false)
  })
})
