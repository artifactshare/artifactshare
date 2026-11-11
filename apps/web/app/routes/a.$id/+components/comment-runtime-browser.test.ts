// @vitest-environment happy-dom
import { afterEach, expect, test, vi } from 'vitest'
import {
  acquireCommentRuntime,
  withCommentRuntime,
} from './comment-runtime-browser'

afterEach(() => vi.unstubAllGlobals())

test('server callers cannot create a shared browser runtime', () => {
  vi.stubGlobal('window', undefined)
  expect(() => acquireCommentRuntime('artifact')).toThrow('browser environment')
})

test('browser operations share a retained record and release it after settlement', () => {
  const display = acquireCommentRuntime('artifact')
  const post = display.beginMutation('mutation', 'thread')
  display.release()
  expect(withCommentRuntime('artifact', (lease) => lease.hasPending())).toBe(
    true,
  )
  post.settle({ appliedThreads: false, threadId: 'thread' })
  expect(
    withCommentRuntime('artifact', (lease) => lease.getEpoch('thread')),
  ).toBe(0)
  expect(withCommentRuntime('artifact', (lease) => lease.hasPending())).toBe(
    false,
  )
})
