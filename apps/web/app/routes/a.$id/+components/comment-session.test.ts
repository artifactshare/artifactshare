import { afterEach, expect, test, vi } from 'vitest'
import { commentFixture } from '~/test/comment-fixtures'
import { waitForRealTaskCondition } from '~/test/wait-for-real-task-condition'
import { createCommentRuntime } from './comment-runtime'
import { createCommentSession } from './comment-session'

afterEach(() => vi.unstubAllGlobals())
const initial = [commentFixture('one'), commentFixture('two')]
function setup() {
  const runtime = createCommentRuntime()
  let selected: string | null = null
  const session = createCommentSession({
    artifactId: 'a',
    initialThreads: initial,
    currentUserId: 'reviewer',
    getSelectedThreadId: () => selected,
    acquireRuntime: () => runtime.acquire('a'),
    // The socket adapter owns recovery policy; these tests control refresh explicitly.
    onMutationSettled: () => {},
  })
  const detach = session.attach()
  return {
    session,
    runtime,
    detach,
    select: (id: string | null) => {
      selected = id
    },
  }
}

test('retained recovery is consumed once and cannot survive detach/reattach', () => {
  const { session, detach } = setup()
  const recovered = [commentFixture('one', 'recovered')]
  const accepted = [{ ...recovered[0], latestReplyIds: [], loadedPages: [] }]
  let detachAgain: (() => void) | undefined
  try {
    session.retainRecovery(session.captureRecovery(), recovered)
    expect(session.hasStaleRecovery()).toBe(false)
    expect(session.applyRecovery()).toBe(true)
    expect(session.getSnapshot().threads).toEqual(accepted)
    expect(session.applyRecovery()).toBe(false)
    session.retainRecovery(session.captureRecovery(), initial)
    detach()
    detachAgain = session.attach()
    expect(session.applyRecovery()).toBe(false)
    expect(session.getSnapshot().threads).toEqual(accepted)
  } finally {
    detach()
    detachAgain?.()
  }
})

test('retained recovery defers to pending settlement and rejects rows captured before settlement', () => {
  const { session, runtime, detach } = setup()
  const writer = runtime.acquire('a')
  const job = writer.beginMutation('pending', 'one')
  try {
    session.retainRecovery(session.captureRecovery(), [
      commentFixture('one', 'before post'),
    ])
    // The authorized connection can continue without publishing these rows.
    expect(session.applyRecovery()).toBe(true)
    expect(session.getSnapshot().threads).toEqual(initial)
    session.retainRecovery(session.captureRecovery(), [
      commentFixture('one', 'stale'),
    ])
    session.applyMutation([commentFixture('one', 'posted')])
    job.settle({ appliedThreads: true, threadId: 'one' })
    expect(session.hasStaleRecovery()).toBe(true)
    expect(session.applyRecovery()).toBe(false)
    expect(session.getSnapshot().threads[0].messages[0].body).toBe('posted')
    expect(session.hasStaleRecovery()).toBe(false)
  } finally {
    job.settle({ appliedThreads: false, threadId: 'one' })
    writer.release()
    detach()
  }
})

test('construction exposes only initial data and does not acquire a browser owner or fetch', () => {
  const acquire = vi.fn()
  const fetch = vi.fn()
  vi.stubGlobal('fetch', fetch)
  const session = createCommentSession({
    artifactId: 'a',
    initialThreads: initial,
    currentUserId: null,
    getSelectedThreadId: () => null,
    acquireRuntime: acquire,
  })
  expect(session.getSnapshot()).toEqual({
    threads: initial,
    failedThreadIds: [],
  })
  session.createPageConsumer({ threadId: 'one', targetMessageId: 'reply' })
  expect(acquire).not.toHaveBeenCalled()
  expect(fetch).not.toHaveBeenCalled()
})

test('an authoritative summary controls membership while a stale superseded response is never published', async () => {
  const requests: ((response: Response) => void)[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(() => new Promise<Response>((resolve) => requests.push(resolve))),
  )
  const { session, detach } = setup()
  const seen: string[] = []
  const unsubscribe = session.subscribe(() =>
    seen.push(...session.getSnapshot().threads.map((t) => t.messages[0].body)),
  )
  try {
    const first = session.requestRefresh()
    session.applyMutation([commentFixture('one', 'posted')], {
      threadId: 'one',
    })
    const replacement = session.requestRefresh()
    requests[0](Response.json({ threads: [commentFixture('one', 'stale')] }))
    await waitForRealTaskCondition(
      () => requests.length === 2,
      'replacement summary requested',
    )
    expect(session.getSnapshot().threads[0].messages[0].body).toBe('posted')
    requests[1](
      Response.json({ threads: [commentFixture('two', 'authoritative')] }),
    )
    await Promise.all([first, replacement])
    expect(session.getSnapshot().threads.map((t) => t.id)).toEqual(['two'])
    expect(seen).not.toContain('stale')
    expect(seen).toContain('authoritative')
  } finally {
    unsubscribe()
    detach()
  }
})

test('changing selection during a targeted read preserves the valid summary and fetches the new target', async () => {
  const requests: { url: string; answer: (response: Response) => void }[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(
      (url: string) =>
        new Promise<Response>((answer) => requests.push({ url, answer })),
    ),
  )
  const { session, select, detach } = setup()
  try {
    select('outside')
    const done = session.requestRefresh()
    requests[0].answer(
      Response.json({ threads: [commentFixture('two', 'summary')] }),
    )
    await waitForRealTaskCondition(() => requests.length === 2, 'selected read')
    select('another')
    requests[1].answer(
      Response.json({
        threads: [commentFixture('outside', 'obsolete selection')],
      }),
    )
    await waitForRealTaskCondition(
      () => requests.length === 3,
      'follow-up summary',
    )
    expect(
      session.getSnapshot().threads.map((t) => t.messages[0].body),
    ).toEqual(['summary'])
    requests[2].answer(
      Response.json({ threads: [commentFixture('two', 'updated summary')] }),
    )
    await waitForRealTaskCondition(
      () => requests.length === 4,
      'current selected read',
    )
    expect(requests[3].url).toBe('/api/shareables/a/comments?thread_id=another')
    requests[3].answer(
      Response.json({
        threads: [commentFixture('another', 'current selection')],
      }),
    )
    await done
    expect(
      session.getSnapshot().threads.map((t) => t.messages[0].body),
    ).toEqual(['updated summary', 'current selection'])
    expect(session.getSnapshot().failedThreadIds).toEqual([])
  } finally {
    detach()
  }
})

test('recovery authorization is separate from data adoption and a settlement invalidates the old snapshot', () => {
  const { session, runtime, detach } = setup()
  try {
    const writer = runtime.acquire('a')
    const ticket = session.captureRecovery()
    writer
      .beginMutation('post', 'one')
      .settle({ appliedThreads: true, threadId: 'one' })
    expect(session.isRecoveryCurrent(ticket)).toBe(false)
    expect(
      session.offerRecovery(ticket, [commentFixture('one', 'stale recovery')]),
    ).toEqual({ kind: 'mutation-invalidated', pending: false })
    expect(session.getSnapshot().threads).toEqual(initial)
    const current = session.captureRecovery()
    expect(
      session.offerRecovery(current, [
        commentFixture('one', 'authorized current rows'),
      ]),
    ).toEqual({ kind: 'applied' })
    expect(
      session.getSnapshot().threads.map((t) => t.messages[0].body),
    ).toEqual(['authorized current rows'])
    writer.release()
  } finally {
    detach()
  }
})

test('a pending mutation defers otherwise current recovery rows and an old attachment cannot apply', () => {
  const { session, runtime, detach } = setup()
  const writer = runtime.acquire('a')
  const ticket = session.captureRecovery()
  const post = writer.beginMutation('pending', 'one')
  expect(
    session.offerRecovery(ticket, [commentFixture('one', 'not yet safe')]),
  ).toEqual({ kind: 'mutation-invalidated', pending: true })
  detach()
  const reattached = session.attach()
  try {
    expect(session.offerRecovery(ticket, initial)).toEqual({ kind: 'detached' })
    post.settle({ appliedThreads: false })
    expect(session.getSnapshot().threads).toEqual(initial)
  } finally {
    writer.release()
    reattached()
  }
})

test('each Session independently consumes its own applied echo and pending IDs stay in Runtime', () => {
  const runtime = createCommentRuntime()
  const make = () =>
    createCommentSession({
      artifactId: 'a',
      initialThreads: initial,
      currentUserId: 'reviewer',
      getSelectedThreadId: () => null,
      acquireRuntime: () => runtime.acquire('a'),
      onMutationSettled: () => {},
    })
  const first = make(),
    second = make()
  const detachFirst = first.attach(),
    detachSecond = second.attach()
  const writer = runtime.acquire('a')
  try {
    writer
      .beginMutation('echo', 'one')
      .settle({ appliedThreads: true, threadId: 'one' })
    const message = {
      threadId: 'one',
      originMutationId: 'echo',
      originUserId: 'reviewer',
    }
    expect(first.remoteChanged(message)).toBe(false)
    expect(second.remoteChanged(message)).toBe(false)
    expect(first.remoteChanged(message)).toBe(true)
  } finally {
    writer.release()
    detachFirst()
    detachSecond()
  }
})

function pageGates() {
  const requests: {
    url: string
    signal: AbortSignal
    answer: (response: Response) => void
  }[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(
      (url: string, init: RequestInit) =>
        new Promise<Response>((answer) =>
          requests.push({ url, signal: init.signal!, answer }),
        ),
    ),
  )
  return requests
}
function pageFixture() {
  const row = commentFixture('one')
  return {
    ...row,
    messages: [
      row.messages[0],
      {
        ...row.messages[0],
        id: 'reply',
        createdAt: '2026-05-02T00:00:00.000Z',
      },
    ],
    messageCount: 2,
    replyCount: 1,
  }
}
const around = { aroundMessageId: 'reply', limit: 50 }

test('consumer construction and inactive loads are read-only; a valid page merges with current membership', async () => {
  const requests = pageGates()
  const { session, detach } = setup()
  const consumer = session.createPageConsumer({ threadId: 'one' })
  expect(await consumer.load(around)).toBe(false)
  expect(requests).toHaveLength(0)
  const changed = vi.fn()
  consumer.subscribe(changed)
  consumer.activate()
  const done = consumer.load(around)
  expect(consumer.getSnapshot().pending).toBe(true)
  expect(await consumer.load(around)).toBe(false)
  const through = btoa(
    JSON.stringify([1, 'one', '2026-05-02T00:00:00.000Z', 'reply']),
  ).replace(/=+$/, '')
  requests[0].answer(
    Response.json({
      threads: [pageFixture(), commentFixture('outside')],
      page: { through },
    }),
  )
  expect(await done).toBe(true)
  expect(session.getSnapshot().threads.map((t) => t.id)).toEqual(['one', 'two'])
  expect(session.getSnapshot().threads[0].loadedPages?.[0]).toMatchObject({
    through,
    limit: 1,
  })
  expect(consumer.getSnapshot()).toEqual({ pending: false, failed: false })
  expect(changed).toHaveBeenCalledTimes(2)
  detach()
})

test('newer dirty intent survives an older summary completion and revalidates the retained page', async () => {
  const requests = pageGates()
  const { session, select, detach } = setup()
  const consumer = session.createPageConsumer({ threadId: 'one' })
  try {
    consumer.activate()
    const loaded = consumer.load(around)
    requests[0].answer(Response.json({ threads: [pageFixture()] }))
    expect(await loaded).toBe(true)
    expect(session.getSnapshot().threads[0].loadedPages).toHaveLength(1)
    select('one')

    const refreshed = session.requestRefresh()
    expect(requests).toHaveLength(2)
    expect(requests[1].url).toBe('/api/shareables/a/comments')
    session.retryTarget()
    expect(requests).toHaveLength(2)
    expect(requests[1].signal.aborted).toBe(false)

    requests[1].answer(Response.json({ threads: [pageFixture(), initial[1]] }))
    await waitForRealTaskCondition(
      () => requests.length === 3,
      'queued summary follows the older completion',
    )
    expect(requests[2].url).toBe('/api/shareables/a/comments')
    expect(session.getSnapshot().threads[0].messages).toEqual(
      pageFixture().messages,
    )
    requests[2].answer(Response.json({ threads: [pageFixture(), initial[1]] }))
    await waitForRealTaskCondition(
      () => requests.length === 4,
      'newer dirty intent revalidates the retained page',
    )
    expect(requests[3].url).toBe(requests[0].url)
    const updated = pageFixture()
    updated.messages[1].body = 'updated retained reply'
    requests[3].answer(Response.json({ threads: [updated] }))
    expect(await refreshed).toBe('keep-connection')
    expect(requests).toHaveLength(4)
    expect(session.getSnapshot().threads.map((thread) => thread.id)).toEqual([
      'one',
      'two',
    ])
    expect(session.getSnapshot().threads[0].messages).toEqual(updated.messages)
    expect(session.getSnapshot().failedThreadIds).toEqual([])
  } finally {
    consumer.cleanup()
    detach()
  }
})

test.each(['one', 'two'])(
  'in-flight page survives %s epoch change and only its own thread revalidates',
  async (threadId) => {
    const requests = pageGates()
    const { session, detach } = setup()
    const consumer = session.createPageConsumer({ threadId: 'one' })
    consumer.activate()
    const done = consumer.load(around)
    session.remoteChanged({ threadId })
    requests[0].answer(Response.json({ threads: [pageFixture()] }))
    expect(await done).toBe(true)
    expect(session.getSnapshot().threads[0].messages).toHaveLength(2)
    expect(requests).toHaveLength(threadId === 'one' ? 2 : 1)
    if (threadId === 'one') {
      requests[1].answer(Response.json({ threads: initial }))
      await waitForRealTaskCondition(
        () => requests.length === 3,
        'dirty retained page requested',
      )
      expect(requests[2].url).toContain('around_message_id=reply')
      requests[2].answer(Response.json({ threads: [pageFixture()] }))
    }
    detach()
  },
)

test.each(['patch', 'summary', 'recovery'] as const)(
  'a late page cannot revive membership removed by %s',
  async (method) => {
    const requests = pageGates()
    const { session, detach } = setup()
    const consumer = session.createPageConsumer({ threadId: 'one' })
    consumer.activate()
    const done = consumer.load(around)
    if (method === 'patch')
      session.applyMutation([], { threadId: 'one', deletedThreadId: 'one' })
    else if (method === 'recovery')
      session.offerRecovery(session.captureRecovery(), [initial[1]])
    else {
      const refreshed = session.requestRefresh()
      requests[1].answer(Response.json({ threads: [initial[1]] }))
      await refreshed
    }
    requests[0].answer(Response.json({ threads: [pageFixture()] }))
    await done
    expect(session.getSnapshot().threads.map((t) => t.id)).toEqual(['two'])
    detach()
  },
)

test.each([404, 410])(
  'normal %i removes the thread without confirmation',
  async (status) => {
    const requests = pageGates()
    const { session, detach } = setup()
    const consumer = session.createPageConsumer({ threadId: 'one' })
    consumer.activate()
    const done = consumer.load({ before: 'cursor' })
    requests[0].answer(Response.json({}, { status }))
    expect(await done).toBe(true)
    expect(requests).toHaveLength(1)
    expect(session.getSnapshot().threads.map((t) => t.id)).toEqual(['two'])
    detach()
  },
)

test.each([200, 404, 410, 500])(
  'around 404 confirms thread existence with %i before advancing target',
  async (status) => {
    const requests = pageGates()
    const { session, detach } = setup()
    const missing = vi.fn()
    const consumer = session.createPageConsumer({
      threadId: 'one',
      onTargetMissing: missing,
    })
    consumer.activate()
    const done = consumer.load(around)
    requests[0].answer(Response.json({}, { status: 404 }))
    await waitForRealTaskCondition(
      () => requests.length === 2,
      'thread confirmation',
    )
    expect(requests[1].url).toBe('/api/shareables/a/comments?thread_id=one')
    requests[1].answer(Response.json({ threads: [initial[0]] }, { status }))
    expect(await done).toBe(status !== 500)
    expect(missing.mock.calls).toEqual(status === 200 ? [['reply']] : [])
    expect(session.getSnapshot().threads.some((t) => t.id === 'one')).toBe(
      status === 200 || status === 500,
    )
    expect(consumer.getSnapshot().failed).toBe(status === 500)
    detach()
  },
)

test('any pending local mutation defers the explicit page until the last settlement', async () => {
  const requests = pageGates()
  const { session, runtime, detach } = setup()
  const writer = runtime.acquire('a')
  const one = writer.beginMutation('first', 'two')
  const two = writer.beginMutation('second', 'two')
  const consumer = session.createPageConsumer({ threadId: 'one' })
  consumer.activate()
  expect(await consumer.load(around)).toBe(false)
  expect(consumer.getSnapshot().pending).toBe(true)
  expect(requests).toHaveLength(0)
  one.settle({ appliedThreads: false, threadId: 'two' })
  expect(requests).toHaveLength(0)
  two.settle({ appliedThreads: false, threadId: 'two' })
  expect(requests).toHaveLength(1)
  requests[0].answer(Response.json({ threads: [pageFixture()] }))
  await waitForRealTaskCondition(
    () => !consumer.getSnapshot().pending,
    'deferred page adopted',
  )
  expect(session.getSnapshot().threads[0].messages).toHaveLength(2)
  writer.release()
  detach()
})

test('same-thread consumers are isolated; disposal and Session detach abort and release even unanswered reads', async () => {
  const requests = pageGates()
  const { session, runtime, detach } = setup()
  const first = session.createPageConsumer({ threadId: 'one' })
  const second = session.createPageConsumer({ threadId: 'one' })
  first.activate()
  second.activate()
  const old = first.load(around)
  const current = second.load(around)
  first.cleanup()
  expect(requests[0].signal.aborted).toBe(true)
  expect(requests[1].signal.aborted).toBe(false)
  requests[1].answer(Response.json({ threads: [pageFixture()] }))
  expect(await current).toBe(true)
  requests[0].answer(
    Response.json({ threads: [commentFixture('one', 'stale')] }),
  )
  expect(await old).toBe(false)
  expect(session.getSnapshot().threads[0].messages).toHaveLength(2)
  const unanswered = second.load(around)
  session.remoteChanged({ threadId: 'one' })
  detach()
  expect(requests[2].signal.aborted).toBe(true)
  expect(second.getSnapshot().pending).toBe(false)
  const fresh = runtime.acquire('a')
  expect(fresh.getEpoch('one')).toBe(0)
  fresh.release()
  requests[2].answer(
    Response.json({ threads: [commentFixture('one', 'detached')] }),
  )
  expect(await unanswered).toBe(false)
})

test('target changes abort old around ownership and each automatic target is attempted once, with explicit retry', async () => {
  const requests = pageGates()
  const { session, detach } = setup()
  const consumer = session.createPageConsumer({
    threadId: 'one',
    targetMessageId: 'old',
  })
  consumer.activate()
  consumer.setTarget('new')
  expect(requests[0].signal.aborted).toBe(true)
  expect(requests[1].url).toContain('around_message_id=new')
  requests[0].answer(
    Response.json({ threads: [commentFixture('one', 'stale')] }),
  )
  requests[1].answer(Response.json({}, { status: 500 }))
  await waitForRealTaskCondition(
    () => consumer.getSnapshot().failed,
    'target failure',
  )
  expect(requests).toHaveLength(2)
  consumer.setTarget('new')
  expect(requests).toHaveLength(2)
  const retry = consumer.load(consumer.getSnapshot().failedRequest!)
  requests[2].answer(Response.json({ threads: [pageFixture()] }))
  expect(await retry).toBe(true)
  expect(requests).toHaveLength(3)
  detach()
})

test.each([401, 403])(
  'page %i preserves membership and retry while signalling existing auth recovery',
  async (status) => {
    const requests = pageGates()
    const runtime = createCommentRuntime()
    const recover = vi.fn()
    const session = createCommentSession({
      artifactId: 'a',
      initialThreads: initial,
      currentUserId: null,
      getSelectedThreadId: () => null,
      acquireRuntime: () => runtime.acquire('a'),
      onPageAuthError: recover,
    })
    const detach = session.attach()
    const consumer = session.createPageConsumer({ threadId: 'one' })
    consumer.activate()
    const done = consumer.load(around)
    requests[0].answer(Response.json({}, { status }))
    expect(await done).toBe(false)
    expect(recover).toHaveBeenCalledOnce()
    expect(session.getSnapshot().threads).toEqual(initial)
    expect(consumer.getSnapshot()).toEqual({
      pending: false,
      failed: true,
      failedRequest: around,
    })
    expect(requests).toHaveLength(1)
    detach()
  },
)

test.each([401, 403])(
  'around confirmation %i retains retry and signals recovery without advancing target',
  async (status) => {
    const requests = pageGates()
    const runtime = createCommentRuntime()
    const recover = vi.fn()
    const missing = vi.fn()
    const session = createCommentSession({
      artifactId: 'a',
      initialThreads: initial,
      currentUserId: null,
      getSelectedThreadId: () => null,
      acquireRuntime: () => runtime.acquire('a'),
      onPageAuthError: recover,
    })
    const detach = session.attach()
    const consumer = session.createPageConsumer({
      threadId: 'one',
      onTargetMissing: missing,
    })
    consumer.activate()
    const done = consumer.load(around)
    requests[0].answer(Response.json({}, { status: 404 }))
    await waitForRealTaskCondition(
      () => requests.length === 2,
      'confirmation read',
    )
    requests[1].answer(Response.json({}, { status }))
    expect(await done).toBe(false)
    expect(missing).not.toHaveBeenCalled()
    expect(recover).toHaveBeenCalledOnce()
    expect(session.getSnapshot().threads).toEqual(initial)
    expect(consumer.getSnapshot().failedRequest).toEqual(around)
    detach()
  },
)

test('cleanup clears a queued read and pending automatic target before settlement', async () => {
  const requests = pageGates()
  const { session, runtime, detach } = setup()
  const writer = runtime.acquire('a')
  const mutation = writer.beginMutation('pending', 'two')
  const consumer = session.createPageConsumer({
    threadId: 'one',
    targetMessageId: 'reply',
  })
  consumer.activate()
  await consumer.load({ before: 'cursor' })
  consumer.cleanup()
  mutation.settle({ appliedThreads: false, threadId: 'two' })
  expect(requests).toHaveLength(0)
  expect(consumer.getSnapshot()).toEqual({ pending: false, failed: false })
  writer.release()
  detach()
})
