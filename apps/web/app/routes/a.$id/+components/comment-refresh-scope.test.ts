import { expect, test } from 'vitest'
import { createCommentRefreshScope } from './comment-refresh-scope'

test('all retained ranges supersede a leftover dirty thread and survive failed attempts', () => {
  const scope = createCommentRefreshScope()
  scope.snapshot().complete()
  scope.mark('x')
  const interrupted = scope.snapshot()
  expect(interrupted.has('y')).toBe(false)
  scope.mark()
  interrupted.complete()
  expect(scope.snapshot().has('y')).toBe(true)
  const authoritative = scope.snapshot()
  expect(authoritative.has('x')).toBe(true)
  expect(authoritative.has('y')).toBe(true)
  authoritative.complete()
  expect(scope.snapshot().has('y')).toBe(false)
})

test('a newer notification for the same thread survives an older completion', () => {
  const scope = createCommentRefreshScope()
  scope.snapshot().complete()
  scope.mark('x')
  const older = scope.snapshot()
  scope.mark('x')
  older.complete()
  expect(scope.snapshot().has('x')).toBe(true)
})
