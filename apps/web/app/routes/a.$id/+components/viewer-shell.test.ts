import type { CommentThreadView } from '~/lib/comments'
import { firstNewCommentThread } from './comment-order'
import { describe, expect, test } from 'vitest'
import {
  classifyLiveRecoveryResponse,
  consumeAppliedCommentMutationEcho,
  createCommentRefreshScheduler,
  createViewerShellState,
  createViewerCommentState,
  viewerCommentReducer,
  mergeLiveViewCount,
  parseLiveMessage,
  rememberAppliedCommentMutationEcho,
  runCommentRefreshWithAuthRecovery,
  shouldClearLatestVersionRetryOnLiveAvailable,
  shouldDeferCommentRefreshDuringMutation,
  shouldPromoteLatestVersionRetry,
  shouldRefreshAfterAppliedCommentMutation,
  viewerShellReducer,
} from './viewer-shell'

describe('parseLiveMessage', () => {
  test('accepts pong heartbeat responses', () => {
    expect(parseLiveMessage('pong')).toEqual({ type: 'pong' })
  })

  test('accepts comments-changed with an originMutationId', () => {
    expect(
      parseLiveMessage(
        JSON.stringify({
          type: 'comments-changed',
          originMutationId: 'mutation-1',
          originUserId: 'user-1',
        }),
      ),
    ).toEqual({
      type: 'comments-changed',
      originMutationId: 'mutation-1',
      originUserId: 'user-1',
    })
  })

  test('keeps comments-changed fetchable when origin ids are invalid', () => {
    expect(
      parseLiveMessage(JSON.stringify({ type: 'comments-changed' })),
    ).toEqual({ type: 'comments-changed' })
    expect(
      parseLiveMessage(
        JSON.stringify({ type: 'comments-changed', originMutationId: null }),
      ),
    ).toEqual({ type: 'comments-changed' })
    expect(
      parseLiveMessage(
        JSON.stringify({ type: 'comments-changed', originMutationId: '' }),
      ),
    ).toEqual({ type: 'comments-changed' })
    expect(
      parseLiveMessage(
        JSON.stringify({
          type: 'comments-changed',
          originMutationId: 'mutation-1',
        }),
      ),
    ).toEqual({ type: 'comments-changed' })
  })

  test('accepts version-changed with a currentVersionId', () => {
    expect(
      parseLiveMessage(
        JSON.stringify({
          type: 'version-changed',
          currentVersionId: 'version-2',
        }),
      ),
    ).toEqual({ type: 'version-changed', currentVersionId: 'version-2' })
  })

  test('ignores version-changed with invalid currentVersionId values', () => {
    expect(
      parseLiveMessage(JSON.stringify({ type: 'version-changed' })),
    ).toBeNull()
    expect(
      parseLiveMessage(
        JSON.stringify({ type: 'version-changed', currentVersionId: null }),
      ),
    ).toBeNull()
    expect(
      parseLiveMessage(
        JSON.stringify({ type: 'version-changed', currentVersionId: '' }),
      ),
    ).toBeNull()
  })

  test('accepts view-count-changed with a non-negative integer viewCount', () => {
    expect(
      parseLiveMessage(
        JSON.stringify({ type: 'view-count-changed', viewCount: 0 }),
      ),
    ).toEqual({ type: 'view-count-changed', viewCount: 0 })
    expect(
      parseLiveMessage(
        JSON.stringify({ type: 'view-count-changed', viewCount: 12 }),
      ),
    ).toEqual({ type: 'view-count-changed', viewCount: 12 })
  })

  test('ignores view-count-changed with invalid viewCount values', () => {
    expect(
      parseLiveMessage(
        JSON.stringify({ type: 'view-count-changed', viewCount: -1 }),
      ),
    ).toBeNull()
    expect(
      parseLiveMessage(
        JSON.stringify({ type: 'view-count-changed', viewCount: 1.5 }),
      ),
    ).toBeNull()
    expect(
      parseLiveMessage(
        JSON.stringify({ type: 'view-count-changed', viewCount: '3' }),
      ),
    ).toBeNull()
    expect(
      parseLiveMessage(JSON.stringify({ type: 'view-count-changed' })),
    ).toBeNull()
    expect(
      parseLiveMessage(
        JSON.stringify({ type: 'view-count-changed', viewCount: NaN }),
      ),
    ).toBeNull()
    expect(
      parseLiveMessage(
        JSON.stringify({
          type: 'view-count-changed',
          viewCount: Number.POSITIVE_INFINITY,
        }),
      ),
    ).toBeNull()
  })
})

describe('applied comment mutation echo tracking', () => {
  test('consumes an applied mutation echo once', () => {
    const echoes = new Map<string, number>()

    rememberAppliedCommentMutationEcho(echoes, 'mutation-1', 1_000)

    expect(consumeAppliedCommentMutationEcho(echoes, 'mutation-1', 1_001)).toBe(
      true,
    )
    expect(consumeAppliedCommentMutationEcho(echoes, 'mutation-1', 1_002)).toBe(
      false,
    )
  })

  test('evicts expired mutation echoes', () => {
    const echoes = new Map<string, number>()

    rememberAppliedCommentMutationEcho(echoes, 'mutation-1', 1_000)

    expect(
      consumeAppliedCommentMutationEcho(echoes, 'mutation-1', 31_001),
    ).toBe(false)
    expect(echoes.size).toBe(0)
  })

  test('bounds unconsumed mutation echoes', () => {
    const echoes = new Map<string, number>()

    for (let index = 0; index < 25; index += 1) {
      rememberAppliedCommentMutationEcho(echoes, `mutation-${index}`, 1_000)
    }

    expect(echoes.size).toBe(20)
    expect(echoes.has('mutation-0')).toBe(false)
    expect(echoes.has('mutation-24')).toBe(true)
  })
})

describe('comment refresh deferral', () => {
  test('defers transient refresh failures while a comment mutation is pending', () => {
    expect(
      shouldDeferCommentRefreshDuringMutation({
        hasPendingMutation: true,
        outcome: 'missing-response',
      }),
    ).toBe(true)
    expect(
      shouldDeferCommentRefreshDuringMutation({
        hasPendingMutation: true,
        outcome: 'response-error',
      }),
    ).toBe(true)
    expect(
      shouldDeferCommentRefreshDuringMutation({
        hasPendingMutation: true,
        outcome: 'body-missing',
      }),
    ).toBe(true)
  })

  test('does not defer transient refresh failures after pending mutations settle', () => {
    expect(
      shouldDeferCommentRefreshDuringMutation({
        hasPendingMutation: false,
        outcome: 'missing-response',
      }),
    ).toBe(false)
    expect(
      shouldDeferCommentRefreshDuringMutation({
        hasPendingMutation: false,
        outcome: 'response-error',
      }),
    ).toBe(false)
    expect(
      shouldDeferCommentRefreshDuringMutation({
        hasPendingMutation: false,
        outcome: 'body-missing',
      }),
    ).toBe(false)
  })

  test('refreshes after applied mutations when deferred work or overlap reconciliation is needed', () => {
    expect(
      shouldRefreshAfterAppliedCommentMutation({
        hasDeferredRefresh: false,
        requiresReconcile: false,
      }),
    ).toBe(false)
    expect(
      shouldRefreshAfterAppliedCommentMutation({
        hasDeferredRefresh: true,
        requiresReconcile: false,
      }),
    ).toBe(true)
    expect(
      shouldRefreshAfterAppliedCommentMutation({
        hasDeferredRefresh: false,
        requiresReconcile: true,
      }),
    ).toBe(true)
  })
})

describe('latest version retry cleanup', () => {
  test('clears only fallback retries when live becomes available', () => {
    expect(shouldClearLatestVersionRetryOnLiveAvailable('fallback')).toBe(true)
    expect(shouldClearLatestVersionRetryOnLiveAvailable('reconcile')).toBe(
      false,
    )
    expect(shouldClearLatestVersionRetryOnLiveAvailable(null)).toBe(false)
  })

  test('promotes a pending fallback retry when reconnect reconcile needs the slot', () => {
    expect(shouldPromoteLatestVersionRetry('fallback', 'reconcile')).toBe(true)
    expect(shouldPromoteLatestVersionRetry('reconcile', 'fallback')).toBe(false)
    expect(shouldPromoteLatestVersionRetry('reconcile', 'reconcile')).toBe(
      false,
    )
    expect(shouldPromoteLatestVersionRetry(null, 'reconcile')).toBe(false)
  })
})

describe('mergeLiveViewCount', () => {
  test('keeps the displayed count monotonic for the current artifact', () => {
    expect(
      mergeLiveViewCount(
        { artifactId: 's1', viewCount: 12 },
        { id: 's1', viewCount: 10 },
        11,
      ),
    ).toEqual({ artifactId: 's1', viewCount: 12 })

    expect(
      mergeLiveViewCount(
        { artifactId: 's1', viewCount: 12 },
        { id: 's1', viewCount: 10 },
        13,
      ),
    ).toEqual({ artifactId: 's1', viewCount: 13 })
  })

  test('keeps a newer loader count when the live notification is stale', () => {
    expect(
      mergeLiveViewCount(
        { artifactId: 's1', viewCount: 10 },
        { id: 's1', viewCount: 12 },
        11,
      ),
    ).toEqual({ artifactId: 's1', viewCount: 12 })
  })

  test('uses the loader count when switching artifacts', () => {
    expect(
      mergeLiveViewCount(
        { artifactId: 'old', viewCount: 12 },
        { id: 's2', viewCount: 4 },
        3,
      ),
    ).toEqual({ artifactId: 's2', viewCount: 4 })
  })
})

describe('classifyLiveRecoveryResponse', () => {
  test('requires an own array-valued threads property', () => {
    expect(
      classifyLiveRecoveryResponse(new Response('{}', { status: 200 }), {
        threads: [],
      }),
    ).toEqual({ outcome: 'authorized', threads: [] })
    expect(
      classifyLiveRecoveryResponse(
        new Response('{}', { status: 200 }),
        Object.create({ threads: [] }),
      ),
    ).toEqual({ outcome: 'indeterminate' })
    for (const body of [{}, { threads: null }, null, []]) {
      expect(
        classifyLiveRecoveryResponse(new Response('{}', { status: 200 }), body),
      ).toEqual({ outcome: 'indeterminate' })
    }
  })

  test('distinguishes denial statuses from other failures', () => {
    for (const status of [401, 403, 404]) {
      expect(
        classifyLiveRecoveryResponse(new Response(null, { status }), null),
      ).toEqual({ outcome: 'denied' })
    }
    expect(
      classifyLiveRecoveryResponse(new Response(null, { status: 500 }), null),
    ).toEqual({ outcome: 'indeterminate' })
  })
})

describe('createCommentRefreshScheduler', () => {
  test('folds concurrent refresh requests into one pending refresh', async () => {
    const refreshes: Array<DeferredRefresh> = []
    const scheduler = createCommentRefreshScheduler(() => {
      const refresh = createDeferredRefresh()
      refreshes.push(refresh)
      return refresh.promise
    })

    const first = scheduler.request()
    const second = scheduler.request()

    expect(second).toBe(first)
    expect(refreshes).toHaveLength(1)

    refreshes[0]?.resolve('keep-connection')
    await nextMicrotask()

    expect(refreshes).toHaveLength(2)

    refreshes[1]?.resolve('keep-connection')
    await expect(first).resolves.toBe('keep-connection')
    await expect(second).resolves.toBe('keep-connection')
  })

  test('returns close-connection from the pending refresh to all waiters', async () => {
    const refreshes: Array<DeferredRefresh> = []
    const scheduler = createCommentRefreshScheduler(() => {
      const refresh = createDeferredRefresh()
      refreshes.push(refresh)
      return refresh.promise
    })

    const first = scheduler.request()
    const second = scheduler.request()

    refreshes[0]?.resolve('keep-connection')
    await nextMicrotask()
    refreshes[1]?.resolve('close-connection')

    await expect(first).resolves.toBe('close-connection')
    await expect(second).resolves.toBe('close-connection')
  })

  test('can cancel a pending refresh without aborting the active request', async () => {
    const refreshes: Array<DeferredRefresh> = []
    const scheduler = createCommentRefreshScheduler(() => {
      const refresh = createDeferredRefresh()
      refreshes.push(refresh)
      return refresh.promise
    })

    const first = scheduler.request()
    scheduler.request()
    scheduler.cancelPending()

    refreshes[0]?.resolve('keep-connection')

    await expect(first).resolves.toBe('keep-connection')
    expect(refreshes).toHaveLength(1)
  })
})

describe('runCommentRefreshWithAuthRecovery', () => {
  test('keeps the connection when a single auth error recovers', async () => {
    const attempts = createAttemptSequence('auth-error', 'success')
    let waits = 0

    await expect(
      runCommentRefreshWithAuthRecovery({
        runAttempt: attempts.run,
        waitBeforeRetry: async () => {
          waits += 1
          return true
        },
      }),
    ).resolves.toBe('keep-connection')

    expect(attempts.count()).toBe(2)
    expect(waits).toBe(1)
  })

  test('closes the connection when an auth error continues after recheck', async () => {
    const attempts = createAttemptSequence('auth-error', 'auth-error')

    await expect(
      runCommentRefreshWithAuthRecovery({
        runAttempt: attempts.run,
        waitBeforeRetry: async () => true,
      }),
    ).resolves.toBe('close-connection')

    expect(attempts.count()).toBe(2)
  })

  test('keeps the connection when auth recheck is canceled', async () => {
    const attempts = createAttemptSequence('auth-error', 'success')

    await expect(
      runCommentRefreshWithAuthRecovery({
        runAttempt: attempts.run,
        waitBeforeRetry: async () => false,
      }),
    ).resolves.toBe('keep-connection')

    expect(attempts.count()).toBe(1)
  })
})

type DeferredRefresh = {
  promise: Promise<'keep-connection' | 'close-connection'>
  resolve: (result: 'keep-connection' | 'close-connection') => void
}

function createDeferredRefresh(): DeferredRefresh {
  let resolve: DeferredRefresh['resolve'] | null = null
  const promise = new Promise<'keep-connection' | 'close-connection'>(
    (innerResolve) => {
      resolve = innerResolve
    },
  )
  if (!resolve) throw new Error('deferred refresh was not initialized')
  return { promise, resolve }
}

type CommentRefreshAttemptOutcome = 'success' | 'auth-error' | 'transient-error'

function createAttemptSequence(...outcomes: CommentRefreshAttemptOutcome[]) {
  let index = 0
  return {
    run: async () => {
      const outcome = outcomes[index]
      index += 1
      if (!outcome) throw new Error('unexpected extra attempt')
      return outcome
    },
    count: () => index,
  }
}

async function nextMicrotask() {
  await Promise.resolve()
}

describe('viewerShellReducer viewer list exclusivity', () => {
  const base = createViewerShellState('artifact-1')

  test('opening the viewer list closes history', () => {
    const state = viewerShellReducer(
      { ...base, historyOpen: true },
      { type: 'viewer-list-open-changed', open: true },
    )
    expect(state.viewerListOpen).toBe(true)
    expect(state.historyOpen).toBe(false)
  })

  test('closing the viewer list records a user close reason', () => {
    const state = viewerShellReducer(
      { ...base, viewerListOpen: true },
      { type: 'viewer-list-open-changed', open: false },
    )
    expect(state.viewerListOpen).toBe(false)
    expect(state.viewerListCloseReason).toBe('user')
  })

  test('records a forced close reason when passed explicitly', () => {
    const state = viewerShellReducer(
      { ...base, viewerListOpen: true },
      { type: 'viewer-list-open-changed', open: false, reason: 'forced' },
    )
    expect(state.viewerListOpen).toBe(false)
    expect(state.viewerListCloseReason).toBe('forced')
  })

  test('reopening clears the recorded close reason', () => {
    const state = viewerShellReducer(
      { ...base, viewerListCloseReason: 'forced' },
      { type: 'viewer-list-open-changed', open: true },
    )
    expect(state.viewerListOpen).toBe(true)
    expect(state.viewerListCloseReason).toBe(null)
  })

  test('opening history closes the viewer list', () => {
    const state = viewerShellReducer(
      { ...base, viewerListOpen: true },
      { type: 'history-open-changed', open: true },
    )
    expect(state.historyOpen).toBe(true)
    expect(state.viewerListOpen).toBe(false)
    expect(state.viewerListCloseReason).toBe('forced')
  })

  test('closing history leaves the viewer list untouched', () => {
    const state = viewerShellReducer(
      { ...base, viewerListOpen: true },
      { type: 'history-open-changed', open: false },
    )
    expect(state.viewerListOpen).toBe(true)
  })

  test('file drag opening history closes the viewer list', () => {
    const state = viewerShellReducer(
      { ...base, viewerListOpen: true },
      { type: 'file-drag-entered' },
    )
    expect(state.historyOpen).toBe(true)
    expect(state.viewerListOpen).toBe(false)
  })

  test('artifact change closes the viewer list and tracks the new id', () => {
    const state = viewerShellReducer(
      { ...base, viewerListOpen: true },
      { type: 'artifact-changed', artifactId: 'artifact-2' },
    )
    expect(state.artifactId).toBe('artifact-2')
    expect(state.viewerListOpen).toBe(false)
    expect(state.viewerListCloseReason).toBe('forced')
  })
})

describe('new-comment target order', () => {
  test('uses panel anchor/reply order, includes resolved cards and requires the exact loaded pair', () => {
    const make = (
      id: string,
      subject: CommentThreadView['subject'],
      count: number,
      status: 'open' | 'resolved' = 'open',
    ): CommentThreadView => ({
      id,
      subject,
      status,
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
      resolvedAt: null,
      canResolve: false,
      messages: Array.from({ length: count }, (_, index) => ({
        id: `${id}-${index}`,
        body: 'Review',
        agent: null,
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
        author: {
          id: 'u1',
          name: null,
          email: 'viewer@example.com',
          image: null,
        },
        canEdit: false,
        canDelete: false,
      })),
    })
    const attached: CommentThreadView['subject'] = {
      kind: 'text',
      state: 'attached',
      positionState: 'attached',
      quotedText: 'Review',
      prefixText: '',
      suffixText: '',
      targetPath: '/index.html',
      versionId: 'v1',
      textStart: null,
      textEnd: null,
      cssPath: null,
    }
    const orphaned: CommentThreadView['subject'] = {
      ...attached,
      state: 'orphaned',
      positionState: 'needs-check',
    }
    const threads = [
      make('orphan', orphaned, 5),
      make('artifact', { kind: 'artifact' }, 4),
      make('short', attached, 1),
      make('resolved', attached, 3, 'resolved'),
    ]
    const pairs = threads.map((thread) => ({
      threadId: thread.id,
      messageId: `${thread.id}-0`,
    }))
    expect(firstNewCommentThread(threads, pairs)).toBe('resolved')
    expect(firstNewCommentThread(threads, pairs.slice(0, 3))).toBe('short')
    expect(firstNewCommentThread(threads, pairs.slice(0, 2))).toBe('artifact')
    expect(firstNewCommentThread(threads, pairs.slice(0, 1))).toBe('orphan')
    expect(
      firstNewCommentThread(threads, [
        { threadId: 'resolved', messageId: 'deleted' },
      ]),
    ).toBeNull()
    expect(
      firstNewCommentThread(threads, [
        { threadId: 'artifact', messageId: 'resolved-0' },
      ]),
    ).toBeNull()
    expect(firstNewCommentThread([], pairs)).toBeNull()
    expect(firstNewCommentThread(threads, [])).toBeNull()
  })
})

describe('opening an existing comment target', () => {
  const base = createViewerCommentState('s1', 'v1', [], null)

  test.each(['start', 'center'] as const)(
    'ordinary open preserves the target and %s alignment',
    (scroll) => {
      const targeted = viewerCommentReducer(base, {
        type: 'thread-targeted',
        threadId: 'thread-1',
        scroll,
      })
      const opened = viewerCommentReducer(targeted, {
        type: 'panel-open-changed',
        open: true,
      })
      expect(opened).toMatchObject({
        panelOpen: true,
        targetThreadId: 'thread-1',
        targetThreadScroll: scroll,
        focusTargetOnOpen: false,
      })
      const closed = viewerCommentReducer(opened, {
        type: 'panel-open-changed',
        open: false,
      })
      expect(
        viewerCommentReducer(closed, {
          type: 'panel-open-changed',
          open: true,
        }),
      ).toMatchObject({
        targetThreadId: null,
        targetThreadScroll: 'start',
        focusTargetOnOpen: false,
      })
    },
  )

  test('opening is remembered across close and reset for another artifact', () => {
    expect(base.panelHasOpened).toBe(false)
    const opened = viewerCommentReducer(base, {
      type: 'panel-open-changed',
      open: true,
    })
    const closed = viewerCommentReducer(opened, {
      type: 'panel-open-changed',
      open: false,
    })
    expect(closed.panelHasOpened).toBe(true)
    expect(
      viewerCommentReducer(closed, {
        type: 'artifact-changed',
        artifactId: 's2',
        currentVersionId: 'v2',
        threads: [],
      }).panelHasOpened,
    ).toBe(false)
  })

  test('a resolved revisit request replaces an existing target', () => {
    const targeted = viewerCommentReducer(base, {
      type: 'thread-targeted',
      threadId: 'thread-1',
      scroll: 'center',
    })
    expect(
      viewerCommentReducer(targeted, {
        type: 'panel-open-changed',
        open: true,
        revisitThreadId: 'thread-2',
      }),
    ).toMatchObject({
      targetThreadId: 'thread-2',
      targetThreadScroll: 'start',
      focusTargetOnOpen: true,
    })
  })

  test.each(['deep-link', 'anchor-navigation'] as const)(
    'a count request with no matching message preserves the %s target',
    (source) => {
      const targeted =
        source === 'deep-link'
          ? createViewerCommentState('s1', 'v1', [], 'thread-1')
          : viewerCommentReducer(base, {
              type: 'thread-targeted',
              threadId: 'thread-1',
              scroll: 'center',
            })
      const revisitThreadId = firstNewCommentThread(targeted.threads, [
        { threadId: 'thread-deleted', messageId: 'message-deleted' },
      ])
      expect(revisitThreadId).toBeNull()
      const opened = viewerCommentReducer(targeted, {
        type: 'panel-open-changed',
        open: true,
        revisitThreadId,
      })
      expect(opened).toMatchObject({
        panelOpen: true,
        targetThreadId: 'thread-1',
        targetThreadScroll: source === 'deep-link' ? 'start' : 'center',
        focusTargetOnOpen: false,
      })
      const closed = viewerCommentReducer(opened, {
        type: 'panel-open-changed',
        open: false,
      })
      expect(
        viewerCommentReducer(closed, {
          type: 'panel-open-changed',
          open: true,
          revisitThreadId,
        }),
      ).toMatchObject({
        targetThreadId: null,
        targetThreadScroll: 'start',
        focusTargetOnOpen: false,
      })
    },
  )
})
