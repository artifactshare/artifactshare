// @vitest-environment happy-dom
import { act, createElement, useEffect } from 'react'
import { renderToString } from 'react-dom/server'
import * as runtimeBrowser from './comment-runtime-browser'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { useViewerComments } from './viewer-shell'
import { acquireCommentRuntime } from './comment-runtime-browser'
import {
  commentFixture,
  runCommentSyncScenario,
} from '~/test/comment-sync-harness'

vi.mock('react-router', async (original) => ({
  ...(await original<typeof import('react-router')>()),
  useRevalidator: () => ({ revalidate: vi.fn() }),
}))
vi.mock('~/hooks/use-t', async () => {
  const { bindI18n } = await import('~/lib/i18n')
  return { useT: () => bindI18n('en') }
})
beforeEach(() => vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true))
afterEach(() => vi.unstubAllGlobals())

const rows = (body: string) => [
  commentFixture('selected', body),
  commentFixture('other'),
]
const expectedRows = (body: string) => [
  { id: 'selected', bodies: [body] },
  { id: 'other', bodies: ['other'] },
]

// Each scenario owns its React root and HTTP gates; disposal proves shared records empty.
async function navigationScenario() {
  return runCommentSyncScenario(async (driver) => {
    await driver.mount('a')
    await driver.draft('submitted')
    const post = await driver.post()
    await driver.waitForRequests(1)
    await driver.mount('b')
    expect(driver.snapshot().threads).toEqual([
      { id: 'b-only', bodies: ['B original'] },
    ])
    expect(driver.snapshot().pending).toEqual([[], []])
    await driver.mount('a')
    await driver.draft('submitted')
    expect(driver.snapshot().pending).toEqual([[], []])
    expect(driver.pending()).toBe(true)
    await driver.respond(0, { threadId: 'selected', threads: rows('posted') })
    await act(async () => expect(await post.done).toBe(true))
    const afterPost = driver.snapshot()
    expect(afterPost.threads).toEqual(expectedRows('posted'))
    expect(afterPost.drafts).toEqual({ selected: 'submitted' })
    expect(afterPost.pending).toEqual([[], []])
    await driver.waitForRequests(2)
    await driver.respond(1, { threads: rows('reconciled') })
    const final = driver.snapshot()
    expect(final).toEqual({
      artifact: 'a',
      target: null,
      threads: expectedRows('reconciled'),
      drafts: { selected: 'submitted' },
      pending: [[], []],
      failed: false,
    })
    expect(driver.trace).toEqual([
      'POST /api/shareables/a/comments',
      'GET /api/shareables/a/comments',
    ])
    return { afterPost, final, trace: [...driver.trace] }
  })
}

test('navigation retains the newer draft through pending post settlement', async () => {
  await navigationScenario()
})

test('a successful panel post clears its own unchanged submitted draft', async () => {
  async function scenario() {
    return runCommentSyncScenario(async (driver) => {
      await driver.mount()
      await driver.draft('submitted')
      const post = await driver.post()
      await driver.waitForRequests(1)
      await driver.respond(0, { threadId: 'selected', threads: rows('posted') })
      await act(async () => expect(await post.done).toBe(true))
      expect(driver.snapshot().drafts).toEqual({})
      expect(driver.snapshot().threads).toEqual(expectedRows('posted'))
      await driver.waitForRequests(2)
      await driver.respond(1, { threads: rows('reconciled') })
      const result = driver.snapshot()
      expect(result.drafts).toEqual({})
      expect(result.pending).toEqual([[], []])
      expect(result.threads).toEqual(expectedRows('reconciled'))
      return result
    })
  }
  await scenario()
})

test('an A response arriving while B is displayed cannot replace B data', async () => {
  async function scenario() {
    return runCommentSyncScenario(async (driver) => {
      await driver.mount('a')
      const post = await driver.post()
      await driver.waitForRequests(1)
      await driver.mount('b')
      await driver.respond(0, {
        threadId: 'selected',
        threads: rows('A committed'),
      })
      await act(async () => expect(await post.done).toBe(false))
      expect(driver.pending('a')).toBe(false)
      expect(driver.epoch('a')).toBe(0)
      const snapshot = driver.snapshot()
      expect(snapshot.artifact).toBe('b')
      expect(snapshot.threads).toEqual([
        { id: 'b-only', bodies: ['B original'] },
      ])
      expect(driver.requests).toHaveLength(1)
      return snapshot
    })
  }
  await scenario()
})

async function overlappingScenario() {
  return runCommentSyncScenario(async (driver) => {
    await driver.mount()
    await driver.draft('popover')
    const panelPost = await driver.post(0, 'panel')
    const popoverPost = await driver.post(1, 'popover')
    await driver.waitForRequests(2)
    expect(driver.snapshot().pending).toEqual([
      ['reply:selected'],
      ['reply:selected'],
    ])
    await driver.respond(0, {
      threadId: 'selected',
      threads: rows('partial panel response'),
    })
    await act(async () => expect(await panelPost.done).toBe(true))
    expect(driver.pending()).toBe(true)
    expect(driver.snapshot().threads).toEqual(expectedRows('selected'))
    expect(driver.snapshot().pending).toEqual([[], ['reply:selected']])
    expect(driver.requests).toHaveLength(2)
    await driver.respond(1, {
      threadId: 'selected',
      threads: rows('partial popover response'),
    })
    await act(async () => expect(await popoverPost.done).toBe(true))
    // Neither partial response is a complete authoritative result of both posts.
    expect(driver.snapshot().threads).toEqual(expectedRows('selected'))
    expect(driver.pending()).toBe(false)
    await driver.waitForRequests(3)
    await driver.respond(2, { threads: rows('both committed') })
    const snapshot = driver.snapshot()
    expect(snapshot.threads).toEqual(expectedRows('both committed'))
    expect(snapshot.pending).toEqual([[], []])
    expect(snapshot.drafts).toEqual({ selected: 'popover' })
    expect(driver.trace).toEqual([
      'POST /api/shareables/a/comments',
      'POST /api/shareables/a/comments',
      'GET /api/shareables/a/comments',
    ])
    return { snapshot, trace: [...driver.trace] }
  })
}

test('independent panel and popover posts share overlap tracking until reconciliation', async () => {
  await overlappingScenario()
})

test('a detached post releases its record before a fresh display opens', async () => {
  async function scenario() {
    return runCommentSyncScenario(async (driver) => {
      await driver.mount()
      const post = await driver.post()
      await driver.waitForRequests(1)
      await driver.unmount()
      expect(driver.pending()).toBe(true)
      await driver.respond(0, {
        threadId: 'selected',
        threads: rows('detached response'),
      })
      await act(async () => expect(await post.done).toBe(true))
      expect(driver.pending()).toBe(false)
      expect(driver.epoch()).toBe(0)
      // No detached subscriber requested a summary and a new display starts fresh.
      expect(driver.requests).toHaveLength(1)
      await driver.mount()
      expect(driver.snapshot().threads).toEqual(expectedRows('selected'))
      expect(driver.snapshot().pending).toEqual([[], []])
      return { snapshot: driver.snapshot(), trace: [...driver.trace] }
    })
  }
  await scenario()
})

test('a fresh display reconciles a detached post without adopting its old display response or clearing its draft', async () => {
  async function scenario() {
    return runCommentSyncScenario(async (driver) => {
      await driver.mount()
      const post = await driver.post()
      await driver.waitForRequests(1)
      await driver.unmount()
      await driver.mount()
      await driver.draft('submitted')
      await driver.respond(0, {
        threadId: 'selected',
        threads: rows('old display response'),
      })
      await act(async () => expect(await post.done).toBe(true))
      expect(driver.snapshot().threads).toEqual(expectedRows('selected'))
      expect(driver.snapshot().drafts).toEqual({
        selected: 'submitted',
      })
      await driver.waitForRequests(2)
      await driver.respond(1, { threads: rows('current server result') })
      const snapshot = driver.snapshot()
      expect(snapshot.threads).toEqual(expectedRows('current server result'))
      expect(snapshot.drafts).toEqual({ selected: 'submitted' })
      expect(snapshot.pending).toEqual([[], []])
      expect(driver.trace).toEqual([
        'POST /api/shareables/a/comments',
        'GET /api/shareables/a/comments',
      ])
      return { snapshot, trace: [...driver.trace] }
    })
  }
  await scenario()
})

test('A post returning after an earlier GET is visible even when the settlement GET fails', async () => {
  const scenario = () =>
    runCommentSyncScenario(async (driver) => {
      await driver.mount('a')
      const post = await driver.post()
      await driver.mount('b')
      await driver.mount('a')
      await driver.draft('new A draft')
      await driver.retryTarget()
      await driver.waitForRequests(2)
      await driver.respond(1, { threads: rows('stale before post') })
      expect(driver.snapshot().threads).toEqual(expectedRows('selected'))
      await driver.respond(0, {
        threadId: 'selected',
        threads: rows('posted immediately'),
      })
      await act(async () => expect(await post.done).toBe(true))
      expect(driver.snapshot().threads).toEqual(
        expectedRows('posted immediately'),
      )
      await driver.waitForRequests(3)
      await driver.respond(2, {}, 503)
      const snapshot = driver.snapshot()
      expect(snapshot.threads).toEqual(expectedRows('posted immediately'))
      expect(snapshot.drafts).toEqual({ selected: 'new A draft' })
      expect(driver.trace).toEqual([
        'POST /api/shareables/a/comments',
        'GET /api/shareables/a/comments',
        'GET /api/shareables/a/comments',
      ])
      return { snapshot, trace: [...driver.trace] }
    })
  await scenario()
})

test('server rendering acquires no browser Runtime', () => {
  const acquire = vi.spyOn(runtimeBrowser, 'acquireCommentRuntime')
  function View() {
    const comments = useViewerComments({
      framePresent: false,
      artifactId: 'ssr',
      currentUserId: null,
      currentVersionId: null,
      initialThreads: rows('server'),
      targetCommentId: null,
      liveEnabled: false,
    })
    return createElement('span', null, comments.totalCount)
  }
  try {
    expect(renderToString(createElement(View))).toBe('<span>2</span>')
    expect(acquire).not.toHaveBeenCalled()
  } finally {
    acquire.mockRestore()
  }
})

test('the isolation oracle detects an injected lease leak even when no mutation advanced its epoch', async () => {
  const leases: ReturnType<typeof acquireCommentRuntime>[] = []
  function LeakingLease({ artifactId }: { artifactId: string }) {
    useEffect(() => {
      leases.push(acquireCommentRuntime(artifactId))
    }, [artifactId])
    return null
  }
  try {
    await expect(
      runCommentSyncScenario((driver) => driver.mount(), LeakingLease),
    ).rejects.toMatchObject({ name: 'AssertionError' })
  } finally {
    for (const lease of leases) lease.release()
  }
  // The intentionally faulty run must not contaminate a later valid one.
  await runCommentSyncScenario((driver) => driver.mount())
})

test('a failed scenario keeps the original error when unfinished HTTP cleanup also fails its oracle', async () => {
  const original = new Error('Synthetic snapshot mismatch')
  await expect(
    runCommentSyncScenario(async (driver) => {
      await driver.mount()
      await driver.post()
      throw original
    }),
  ).rejects.toMatchObject({
    name: 'AggregateError',
    errors: [original, expect.objectContaining({ name: 'AssertionError' })],
  })
  await runCommentSyncScenario((driver) => driver.mount())
})

test('the driver observes target failure, explicit recovery and request cancellation', async () => {
  async function scenario() {
    return runCommentSyncScenario(async (driver) => {
      await driver.mount('a', 'outside')
      await driver.waitForRequests(1)
      expect(driver.requests[0].path).toBe('/api/shareables/a/comments')
      await driver.respond(0, { error: 'Synthetic offline' }, 503)
      expect(driver.snapshot().failed).toBe(true)
      await driver.retryTarget()
      await driver.waitForRequests(2)
      await driver.respond(1, { threads: rows('summary') })
      await driver.waitForRequests(3)
      await driver.respond(2, {
        threads: [commentFixture('outside', 'Recovered target')],
      })
      expect(driver.snapshot().failed).toBe(false)
      expect(driver.snapshot().threads).toEqual([
        ...expectedRows('summary'),
        { id: 'outside', bodies: ['Recovered target'] },
      ])
      const recovered = driver.snapshot()
      expect(recovered.target).toBe('outside')
      await driver.mount('a', 'another-target')
      await driver.waitForRequests(4)
      await driver.mount('b')
      expect(driver.snapshot()).toEqual({
        artifact: 'b',
        target: null,
        threads: [{ id: 'b-only', bodies: ['B original'] }],
        drafts: {},
        pending: [[], []],
        failed: false,
      })
      expect(driver.trace).toEqual([
        'GET /api/shareables/a/comments',
        'GET /api/shareables/a/comments',
        'GET /api/shareables/a/comments?thread_id=outside',
        'GET /api/shareables/a/comments',
        'cancel GET /api/shareables/a/comments',
      ])
      return { recovered, trace: [...driver.trace] }
    })
  }
  await scenario()
})

test('a throwing React cleanup still drains the held post before restoring fetch', async () => {
  const cleanupError = new Error('Synthetic React cleanup failure')
  function ThrowingCleanup() {
    useEffect(
      () => () => {
        throw cleanupError
      },
      [],
    )
    return null
  }
  let held:
    | { settled: boolean; respond: (body: unknown, status?: number) => void }
    | undefined
  let done: Promise<boolean> | undefined
  let failure: unknown
  const leafErrors = (error: unknown): unknown[] =>
    error instanceof AggregateError ? error.errors.flatMap(leafErrors) : [error]
  try {
    try {
      await runCommentSyncScenario(async (driver) => {
        await driver.mount()
        done = (await driver.post()).done
        await driver.waitForRequests(1)
        held = driver.requests[0]
      }, ThrowingCleanup)
    } catch (error) {
      failure = error
    }
    expect(leafErrors(failure)).toContain(cleanupError)
    expect(held?.settled).toBe(true)
    expect(await done).toBe(false)
  } finally {
    // The red control must not leave its deliberately held POST in this process.
    if (held && !held.settled)
      await act(async () => {
        held!.respond({}, 500)
        await done
      })
  }
  await runCommentSyncScenario((driver) => driver.mount())
})

test('the committed Session survives revalidation/version changes and changes on navigation', async () => {
  await runCommentSyncScenario(async (driver) => {
    await driver.mount('a', null, 'v1')
    const owner = driver.owner()
    await driver.draft('retained draft')
    await driver.mount('a', null, 'v2')
    expect(driver.owner()).toBe(owner)
    expect(driver.snapshot().drafts).toEqual({ selected: 'retained draft' })
    expect(driver.trace).toEqual([])
    await driver.mount('b', null, 'v2')
    expect(driver.owner()).not.toBe(owner)
    await driver.mount('a', null, 'v2')
    expect(driver.owner()).not.toBe(owner)
    expect(driver.trace).toEqual([])
  })
})

test('pending posts survive A → B → A and adopt before failed GET', async () => {
  async function scenario() {
    const events: Array<Record<string, unknown>> = []
    const log = vi.spyOn(console, 'info').mockImplementation((name, event) => {
      if (
        name === 'artifactshare_viewer_network' &&
        event.channel === 'comment-sync'
      )
        events.push(event)
    })
    try {
      return await runCommentSyncScenario(async (driver) => {
        await driver.mount('a')
        await driver.draft('submitted')
        const post = await driver.post()
        await driver.waitForRequests(1)
        await driver.mount('b')
        expect(driver.snapshot().threads).toEqual([
          { id: 'b-only', bodies: ['B original'] },
        ])
        expect(driver.snapshot().pending).toEqual([[], []])
        await driver.mount('a')
        await driver.draft('submitted')
        expect(driver.pending()).toBe(true)
        await driver.respond(0, {
          threadId: 'selected',
          threads: rows('posted immediately'),
        })
        await act(async () => expect(await post.done).toBe(true))
        expect(driver.snapshot().threads).toEqual(
          expectedRows('posted immediately'),
        )
        expect(driver.snapshot().drafts).toEqual({ selected: 'submitted' })
        await driver.waitForRequests(2)
        await driver.respond(1, {}, 503)
        expect(driver.snapshot().threads).toEqual(
          expectedRows('posted immediately'),
        )
        expect(driver.pending()).toBe(false)
        expect(driver.snapshot().pending).toEqual([[], []])
        expect(driver.trace).toEqual([
          'POST /api/shareables/a/comments',
          'GET /api/shareables/a/comments',
        ])
        expect(
          events.map(({ operation, state, result, fetchCount }) => ({
            operation,
            state,
            result,
            fetchCount,
          })),
        ).toEqual([
          {
            operation: 'reply',
            state: 'started',
            result: 'pending',
            fetchCount: 1,
          },
          {
            operation: 'reply',
            state: 'completed',
            result: 'success',
            fetchCount: 0,
          },
          {
            operation: 'summary',
            state: 'started',
            result: 'pending',
            fetchCount: 1,
          },
          {
            operation: 'summary',
            state: 'completed',
            result: 'http-error',
            fetchCount: 0,
          },
        ])
        for (const event of events)
          expect(event.elapsedMs).toEqual(expect.any(Number))
        expect(JSON.stringify(events)).not.toMatch(
          /submitted|selected|posted immediately|\/api\/|token/,
        )
        return { snapshot: driver.snapshot(), trace: [...driver.trace] }
      })
    } finally {
      log.mockRestore()
    }
  }
  await scenario()
})

test('a new display reconciles a detached post without claiming the old producer draft', async () => {
  await runCommentSyncScenario(async (driver) => {
    await driver.mount('a')
    const post = await driver.post()
    await driver.waitForRequests(1)
    await driver.unmount()
    await driver.mount('a')
    await driver.draft('submitted')
    expect(driver.pending()).toBe(true)
    await driver.respond(0, { threadId: 'selected', threads: rows('old post') })
    await act(async () => {
      await post.done
    })
    expect(driver.snapshot().threads).toEqual(expectedRows('selected'))
    await driver.waitForRequests(2)
    await driver.respond(1, { threads: rows('reconciled') })
    expect(driver.snapshot().threads).toEqual(expectedRows('reconciled'))
    expect(driver.snapshot().drafts).toEqual({ selected: 'submitted' })
    expect(driver.trace).toEqual([
      'POST /api/shareables/a/comments',
      'GET /api/shareables/a/comments',
    ])
  })
})
