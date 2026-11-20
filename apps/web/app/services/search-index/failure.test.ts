import { expect, test } from 'vitest'
import { searchFailureReason } from './failure'

test('keeps identifier-shaped failure codes', () => {
  expect(searchFailureReason(new Error('search_source_missing'))).toBe(
    'Error:search_source_missing',
  )
})

test('keeps only the leading D1 or SQLite code', () => {
  expect(
    searchFailureReason(
      new Error('D1_ERROR: UNIQUE constraint failed: documents.path'),
    ),
  ).toBe('Error:D1_ERROR')
  expect(searchFailureReason(new Error('SQLITE_TOOBIG: string too big'))).toBe(
    'Error:SQLITE_TOOBIG',
  )
})

test('keeps a trailing SQLite code from Durable Object storage', () => {
  expect(
    searchFailureReason(
      new Error('UNIQUE constraint failed: documents.path: SQLITE_CONSTRAINT'),
    ),
  ).toBe('Error:SQLITE_CONSTRAINT')
})

test('reports a named error subclass by its name', () => {
  class SearchCleanupError extends Error {
    override name = 'SearchCleanupError'
  }
  expect(
    searchFailureReason(new SearchCleanupError('Network connection lost')),
  ).toBe('SearchCleanupError')
})

test('drops messages that can quote file contents', () => {
  let parseError: unknown
  try {
    JSON.parse('{"secret body text"')
  } catch (error) {
    parseError = error
  }
  expect(searchFailureReason(parseError)).toBe('SyntaxError')
  expect(
    searchFailureReason(new RangeError('Invalid length 12 for "body"')),
  ).toBe('RangeError')
})

test('describes non-Error throws by type only', () => {
  expect(searchFailureReason('raw text')).toBe('string')
  expect(searchFailureReason(undefined)).toBe('undefined')
})
