import { afterEach, expect, test, vi } from 'vitest'
import { createAnchorResolutionSync } from './anchor-resolution-sync'
import type { AnchorResolutionMessage } from './csp-reporter'

const result = (id: string) => ({
  threadId: id,
  state: 'attached' as const,
  textStart: 0,
  textEnd: 4,
  textHash: 'a'.repeat(64),
})
const message = (generation = 1, count = 1): AnchorResolutionMessage => ({
  source: 'artifactshare',
  kind: 'anchor-resolutions',
  token: 'a'.repeat(64),
  versionId: 'v1',
  targetPath: '/index.html',
  generation,
  results: Array.from({ length: count }, (_, index) => result(String(index))),
})
afterEach(() => vi.useRealTimers())

test('reapplies cached results after refreshed threads even when the same verdict was saved', async () => {
  const apply = vi.fn()
  const request = vi
    .fn<typeof fetch>()
    .mockResolvedValue(new Response(null, { status: 200 }))
  const sync = createAnchorResolutionSync('/comments', apply, request)
  sync.accept(message())
  await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1))
  sync.reapply()
  sync.accept(message(2))
  expect(apply).toHaveBeenCalledTimes(3)
  expect(apply).toHaveBeenLastCalledWith(message().results)
  expect(request).toHaveBeenCalledTimes(1)
  sync.accept(message(1))
  expect(apply).toHaveBeenCalledTimes(3)
  sync.dispose()
})

test('acknowledges only HTTP success and retries network errors and non-ok responses', async () => {
  vi.useFakeTimers()
  const request = vi
    .fn<typeof fetch>()
    .mockRejectedValueOnce(new Error('offline'))
    .mockResolvedValueOnce(new Response(null, { status: 503 }))
    .mockResolvedValue(new Response(null, { status: 200 }))
  const sync = createAnchorResolutionSync('/comments', vi.fn(), request)
  sync.accept(message())
  await vi.runAllTimersAsync()
  expect(request).toHaveBeenCalledTimes(3)
  sync.accept(message(2))
  await vi.runAllTimersAsync()
  expect(request).toHaveBeenCalledTimes(3)
  sync.dispose()
})

test('chunks large snapshots and stops retrying when disposed or the backoff is exhausted', async () => {
  vi.useFakeTimers()
  const request = vi
    .fn<typeof fetch>()
    .mockResolvedValue(new Response(null, { status: 200 }))
  const sync = createAnchorResolutionSync('/comments', vi.fn(), request)
  sync.accept(message(1, 205))
  await vi.runAllTimersAsync()
  expect(
    request.mock.calls.map(
      ([, init]) => JSON.parse(init!.body as string).results.length,
    ),
  ).toEqual([100, 100, 5])
  sync.dispose()
  const failure = vi.fn<typeof fetch>().mockRejectedValue(new Error('offline'))
  const retry = createAnchorResolutionSync('/comments', vi.fn(), failure)
  retry.accept(message())
  await vi.runAllTimersAsync()
  expect(failure).toHaveBeenCalledTimes(4)
  retry.dispose()
  retry.accept(message(2))
  await vi.runAllTimersAsync()
  expect(failure).toHaveBeenCalledTimes(4)
})

test('disposal cancels a scheduled retry', async () => {
  vi.useFakeTimers()
  const request = vi.fn<typeof fetch>().mockRejectedValue(new Error('offline'))
  const sync = createAnchorResolutionSync('/comments', vi.fn(), request)
  sync.accept(message())
  await vi.advanceTimersByTimeAsync(0)
  expect(request).toHaveBeenCalledTimes(1)
  sync.dispose()
  await vi.runAllTimersAsync()
  expect(request).toHaveBeenCalledTimes(1)
})

test('an in-flight response from a replaced frame cannot acknowledge its successor', async () => {
  vi.useFakeTimers()
  let finish!: (response: Response) => void
  const request = vi
    .fn<typeof fetch>()
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    )
    .mockResolvedValue(new Response(null, { status: 200 }))
  const apply = vi.fn()
  const sync = createAnchorResolutionSync('/comments', apply, request)
  sync.accept(message())
  const successor = { ...message(), token: 'b'.repeat(64) }
  sync.accept(successor)
  expect(request.mock.calls[0][1]!.signal!.aborted).toBe(true)
  finish(new Response(null, { status: 200 }))
  await vi.runAllTimersAsync()
  expect(request).toHaveBeenCalledTimes(2)
  expect(JSON.parse(request.mock.calls[1][1]!.body as string).frameToken).toBe(
    successor.token,
  )
  sync.reapply()
  expect(apply).toHaveBeenLastCalledWith(successor.results)
  sync.dispose()
})

test('an in-flight acknowledgement deduplicates a newer hash while keeping it in the UI', async () => {
  vi.useFakeTimers()
  let finish!: (response: Response) => void
  const request = vi
    .fn<typeof fetch>()
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    )
    .mockResolvedValue(new Response(null, { status: 200 }))
  const apply = vi.fn()
  const sync = createAnchorResolutionSync('/comments', apply, request)
  sync.accept(message())
  const updated = {
    ...message(2),
    results: [{ ...result('0'), textHash: 'b'.repeat(64) }],
  }
  sync.accept(updated)
  finish(new Response(null, { status: 200 }))
  await vi.runAllTimersAsync()
  expect(request).toHaveBeenCalledTimes(1)
  sync.reapply()
  expect(apply).toHaveBeenLastCalledWith(updated.results)
  sync.accept({ ...updated, generation: 3 })
  await vi.runAllTimersAsync()
  expect(request).toHaveBeenCalledTimes(1)
  sync.dispose()
})

test('mixed snapshots save changed states and hints without saving hash-only changes', async () => {
  vi.useFakeTimers()
  const request = vi
    .fn<typeof fetch>()
    .mockResolvedValue(new Response(null, { status: 200 }))
  const apply = vi.fn()
  const sync = createAnchorResolutionSync('/comments', apply, request)
  sync.accept(message(1, 2))
  await vi.advanceTimersByTimeAsync(0)
  const unchanged = { ...result('0'), textHash: 'b'.repeat(64) }
  const needsCheck = {
    threadId: '1',
    state: 'needs-check' as const,
    textStart: null,
    textEnd: null,
    textHash: null,
  }
  sync.accept({ ...message(2), results: [unchanged, needsCheck] })
  await vi.advanceTimersByTimeAsync(0)
  expect(request).toHaveBeenCalledTimes(2)
  expect(JSON.parse(request.mock.calls[1][1]!.body as string)).toMatchObject({
    generation: 2,
    results: [needsCheck],
  })
  expect(apply).toHaveBeenLastCalledWith([unchanged, needsCheck])

  const shifted = { ...unchanged, textStart: 2, textEnd: 6 }
  sync.accept({ ...message(3), results: [shifted, needsCheck] })
  await vi.advanceTimersByTimeAsync(9999)
  expect(request).toHaveBeenCalledTimes(2)
  await vi.advanceTimersByTimeAsync(1)
  expect(request).toHaveBeenCalledTimes(3)
  expect(JSON.parse(request.mock.calls[2][1]!.body as string)).toMatchObject({
    generation: 3,
    results: [shifted],
  })

  const hashOnly = { ...shifted, textHash: 'c'.repeat(64) }
  sync.accept({ ...message(4), results: [hashOnly, needsCheck] })
  await vi.advanceTimersByTimeAsync(20_000)
  expect(request).toHaveBeenCalledTimes(3)
  sync.reapply()
  expect(apply).toHaveBeenLastCalledWith([hashOnly, needsCheck])
  sync.dispose()
})

test('different results revive an exhausted queue after a cooldown', async () => {
  vi.useFakeTimers()
  const request = vi.fn<typeof fetch>().mockRejectedValue(new Error('offline'))
  const sync = createAnchorResolutionSync('/comments', vi.fn(), request)
  sync.accept(message())
  await vi.runAllTimersAsync()
  expect(request).toHaveBeenCalledTimes(4)
  sync.accept(message(2))
  await vi.runAllTimersAsync()
  expect(request).toHaveBeenCalledTimes(4)
  request.mockResolvedValue(new Response(null, { status: 200 }))
  sync.accept({
    ...message(3),
    results: [{ ...result('0'), textStart: 2, textEnd: 6 }],
  })
  await vi.advanceTimersByTimeAsync(29_999)
  expect(request).toHaveBeenCalledTimes(4)
  await vi.advanceTimersByTimeAsync(1)
  expect(request).toHaveBeenCalledTimes(5)
  expect(JSON.parse(request.mock.calls[4][1]!.body as string).generation).toBe(
    3,
  )
  sync.dispose()
})

test('failed state changes retry after 250 ms and 500 ms, without the hint throttle', async () => {
  vi.useFakeTimers()
  const request = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(new Response(null, { status: 200 }))
    .mockRejectedValueOnce(new Error('offline'))
    .mockResolvedValueOnce(new Response(null, { status: 503 }))
    .mockResolvedValue(new Response(null, { status: 200 }))
  const sync = createAnchorResolutionSync('/comments', vi.fn(), request)
  sync.accept(message())
  await vi.advanceTimersByTimeAsync(0)
  sync.accept({
    ...message(2),
    results: [
      {
        threadId: '0',
        state: 'needs-check',
        textStart: null,
        textEnd: null,
        textHash: null,
      },
    ],
  })
  await vi.advanceTimersByTimeAsync(0)
  expect(request).toHaveBeenCalledTimes(2)
  await vi.advanceTimersByTimeAsync(249)
  expect(request).toHaveBeenCalledTimes(2)
  await vi.advanceTimersByTimeAsync(1)
  expect(request).toHaveBeenCalledTimes(3)
  await vi.advanceTimersByTimeAsync(499)
  expect(request).toHaveBeenCalledTimes(3)
  await vi.advanceTimersByTimeAsync(1)
  expect(request).toHaveBeenCalledTimes(4)
  sync.accept({
    ...message(3),
    results: [
      {
        threadId: '0',
        state: 'needs-check',
        textStart: null,
        textEnd: null,
        textHash: null,
      },
    ],
  })
  await vi.runAllTimersAsync()
  expect(request).toHaveBeenCalledTimes(4)
  sync.dispose()
})
