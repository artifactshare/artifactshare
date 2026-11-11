// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { useViewerComments } from './viewer-shell'
import {
  commentFixture,
  runCommentSyncScenario,
  type CommentSyncEngine,
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

// The same input script can be run with the future engine hook. Each execution
// owns its React root and HTTP gates, and disposal proves shared records empty.
async function navigationScenario(engine: CommentSyncEngine) {
  return runCommentSyncScenario(engine, async (driver) => {
    await driver.mount('a')
    await driver.draft('submitted')
    const post = await driver.post()
    await driver.waitForRequests(1)
    await driver.mount('b')
    expect(driver.snapshot().threads).toEqual([
      { id: 'b-only', bodies: ['B original'] },
    ])
    await driver.mount('a')
    await driver.draft('new draft')
    expect(driver.pending()).toBe(true)
    await driver.respond(0, { threadId: 'selected', threads: rows('posted') })
    await act(async () => expect(await post.done).toBe(true))
    const afterPost = driver.snapshot()
    expect(afterPost.threads).toEqual(expectedRows('posted'))
    expect(afterPost.drafts).toEqual({ selected: 'new draft' })
    expect(afterPost.pending).toEqual([[], []])
    await driver.waitForRequests(2)
    await driver.respond(1, { threads: rows('reconciled') })
    const final = driver.snapshot()
    expect(final).toEqual({
      artifact: 'a',
      threads: expectedRows('reconciled'),
      drafts: { selected: 'new draft' },
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

test('the navigation and new draft scenario has independently verified sequential runs', async () => {
  const first = await navigationScenario(useViewerComments)
  const second = await navigationScenario(useViewerComments)
  expect(second).toEqual(first)
})

test('an A response arriving while B is displayed cannot replace B data', async () => {
  async function scenario() {
    return runCommentSyncScenario(useViewerComments, async (driver) => {
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
      const snapshot = driver.snapshot()
      expect(snapshot.artifact).toBe('b')
      expect(snapshot.threads).toEqual([
        { id: 'b-only', bodies: ['B original'] },
      ])
      expect(driver.requests).toHaveLength(1)
      return snapshot
    })
  }
  expect(await scenario()).toEqual(await scenario())
})

async function overlappingScenario(engine: CommentSyncEngine) {
  return runCommentSyncScenario(engine, async (driver) => {
    await driver.mount()
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
    expect(driver.trace).toEqual([
      'POST /api/shareables/a/comments',
      'POST /api/shareables/a/comments',
      'GET /api/shareables/a/comments',
    ])
    return { snapshot, trace: [...driver.trace] }
  })
}

test('independent panel and popover posts share overlap tracking until reconciliation', async () => {
  expect(await overlappingScenario(useViewerComments)).toEqual(
    await overlappingScenario(useViewerComments),
  )
})

test('a post can finish after every display unmounts without notifying a later display', async () => {
  async function scenario() {
    return runCommentSyncScenario(useViewerComments, async (driver) => {
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
      // No detached subscriber requested a summary and a new display starts fresh.
      expect(driver.requests).toHaveLength(1)
      await driver.mount()
      expect(driver.snapshot().threads).toEqual(expectedRows('selected'))
      expect(driver.snapshot().pending).toEqual([[], []])
      return { snapshot: driver.snapshot(), trace: [...driver.trace] }
    })
  }
  expect(await scenario()).toEqual(await scenario())
})

test('the driver observes target failure, explicit recovery and request cancellation', async () => {
  async function scenario() {
    return runCommentSyncScenario(useViewerComments, async (driver) => {
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
      expect(driver.snapshot().threads).toContainEqual({
        id: 'outside',
        bodies: ['Recovered target'],
      })
      const recovered = driver.snapshot()
      await driver.mount('a', 'another-target')
      await driver.waitForRequests(4)
      await driver.mount('b')
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
  expect(await scenario()).toEqual(await scenario())
})
