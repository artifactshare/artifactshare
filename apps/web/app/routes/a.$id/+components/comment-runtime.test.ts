import { expect, test, vi } from 'vitest'
import { createCommentRuntime } from './comment-runtime'

test('a pending post survives A to B to A while detached subscribers stay silent', () => {
  const runtime = createCommentRuntime()
  const first = runtime.acquire('a')
  const detached = vi.fn()
  first.subscribe(detached)
  const post = first.beginMutation('post', 'thread')
  first.release()
  const other = runtime.acquire('b')
  expect(other.hasPending()).toBe(false)
  const returned = runtime.acquire('a')
  const settled = vi.fn()
  returned.subscribe(settled)
  expect(returned.hasPending('post')).toBe(true)
  post.settle({ appliedThreads: false, threadId: 'thread' })
  expect(returned.hasPending()).toBe(false)
  expect(detached).not.toHaveBeenCalled()
  expect(settled).toHaveBeenCalledExactlyOnceWith({
    clientMutationId: 'post',
    appliedThreads: false,
    threadId: 'thread',
  })
  post.settle({ appliedThreads: true })
  expect(settled).toHaveBeenCalledOnce()
  returned.release()
  other.release()
})

test('records survive read leases and are collected after the last job and lease', () => {
  const runtime = createCommentRuntime()
  const display = runtime.acquire('a')
  const read = runtime.acquire('a')
  display.invalidate('thread')
  const epoch = read.getEpoch('thread')
  display.release()
  expect(read.getEpoch('thread')).toBe(epoch)
  const post = read.beginMutation('post', 'thread')
  read.release()
  post.settle({ appliedThreads: false })
  const reopened = runtime.acquire('a')
  expect(reopened.getEpoch('thread')).toBe(0)
  expect(() => read.invalidate()).toThrow('lease released')
  reopened.release()
})

test('thread invalidation is scoped and artifact invalidation covers every thread', () => {
  const lease = createCommentRuntime().acquire('a')
  lease.invalidate('one')
  expect(lease.getEpoch('one')).toBeGreaterThan(0)
  expect(lease.getEpoch('two')).toBe(0)
  lease.invalidate()
  expect(lease.getEpoch('two')).toBe(lease.getEpoch('one'))
  lease.release()
})

test('recovery snapshots observe settlements across all threads separately from invalidation and request ownership', () => {
  const runtime = createCommentRuntime()
  const display = runtime.acquire('a')
  const read = runtime.acquire('a')
  const captured = read.getSettlementRevision()
  display.invalidate('one')
  const post = display.beginMutation('post', 'two')
  expect(read.getSettlementRevision()).toBe(captured)
  post.settle({ appliedThreads: false, threadId: 'two' })
  const settled = read.getSettlementRevision()
  expect(settled).toBeGreaterThan(captured)
  display.invalidate()
  expect(read.getSettlementRevision()).toBe(settled)
  display.release()
  expect(read.getSettlementRevision()).toBe(settled)
  read.release()
  const next = runtime.acquire('a')
  expect(next.getSettlementRevision()).toBe(0)
  next.release()
})

test('overlap persists until every overlapping post settles', () => {
  const lease = createCommentRuntime().acquire('a')
  const first = lease.beginMutation('one')
  const second = lease.beginMutation('two')
  expect(() => lease.beginMutation('one')).toThrow('Duplicate')
  first.settle({ appliedThreads: false })
  expect(lease.hasPending('two')).toBe(true)
  expect(lease.hasOverlap()).toBe(true)
  second.settle({ appliedThreads: false })
  expect(lease.hasOverlap()).toBe(false)
  lease.release()
})

test('separate runtime instances cannot share pending posts or epochs', () => {
  const first = createCommentRuntime().acquire('a')
  const second = createCommentRuntime().acquire('a')
  const post = first.beginMutation('post')
  expect(second.hasPending()).toBe(false)
  expect(second.getEpoch('thread')).toBe(0)
  first.release()
  post.settle({ appliedThreads: false })
  second.release()
})

test('subscriber failures and removals cannot block other live viewers', () => {
  const report = vi.fn()
  const runtime = createCommentRuntime(report)
  const first = runtime.acquire('a')
  const removed = runtime.acquire('a')
  const last = runtime.acquire('a')
  const error = new Error('subscriber failed')
  first.subscribe(() => {
    removed.release()
    throw error
  })
  const removedListener = vi.fn()
  removed.subscribe(removedListener)
  const delivered = vi.fn()
  last.subscribe(delivered)
  first.beginMutation('post').settle({ appliedThreads: false })
  expect(report).toHaveBeenCalledExactlyOnceWith(error)
  expect(removedListener).not.toHaveBeenCalled()
  expect(delivered).toHaveBeenCalledOnce()
  first.release()
  last.release()
})

test('a failed error reporter does not stop settlement delivery', () => {
  const runtime = createCommentRuntime(() => {
    throw new Error('reporter failed')
  })
  const lease = runtime.acquire('a')
  lease.subscribe(() => {
    throw new Error('subscriber failed')
  })
  const delivered = vi.fn()
  lease.subscribe(delivered)
  expect(() =>
    lease.beginMutation('post').settle({ appliedThreads: false }),
  ).not.toThrow()
  expect(delivered).toHaveBeenCalledOnce()
  expect(lease.hasPending()).toBe(false)
  lease.release()
})

test('reacquiring during settlement cannot let the old record collect the new one', () => {
  const runtime = createCommentRuntime()
  const writer = runtime.acquire('a')
  const job = writer.beginMutation('post')
  writer.release()
  const observer = runtime.acquire('a')
  let replacement!: ReturnType<typeof runtime.acquire>
  observer.subscribe(() => {
    observer.release()
    replacement = runtime.acquire('a')
    replacement.invalidate('fresh')
  })
  job.settle({ appliedThreads: false })
  const nextReader = runtime.acquire('a')
  expect(nextReader.getEpoch('fresh')).toBe(replacement.getEpoch('fresh'))
  nextReader.release()
  replacement.release()
})
