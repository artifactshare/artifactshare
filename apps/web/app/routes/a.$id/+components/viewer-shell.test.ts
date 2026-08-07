import { describe, expect, test } from 'vitest'
import {
  consumeAppliedCommentMutationEcho,
  createCommentRefreshScheduler,
  mergeLiveViewCount,
  parseLiveMessage,
  rememberAppliedCommentMutationEcho,
  runCommentRefreshWithAuthRecovery,
  shouldClearLatestVersionRetryOnLiveAvailable,
  shouldDeferCommentRefreshDuringMutation,
  shouldPromoteLatestVersionRetry,
  shouldRefreshAfterAppliedCommentMutation,
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

  test('returns restore-connection from a stopped connection check', async () => {
    const scheduler = createCommentRefreshScheduler(async () => {
      return 'restore-connection'
    })

    await expect(
      scheduler.request({
        authMode: 'single-auth-check',
        successResult: 'restore-connection',
      }),
    ).resolves.toBe('restore-connection')
  })

  test('uses folded request options for the pending refresh', async () => {
    const refreshes: Array<DeferredRefresh> = []
    const optionsSeen: unknown[] = []
    const scheduler = createCommentRefreshScheduler((options) => {
      optionsSeen.push(options)
      const refresh = createDeferredRefresh()
      refreshes.push(refresh)
      return refresh.promise
    })

    const first = scheduler.request()
    const second = scheduler.request({
      authMode: 'single-auth-check',
      successResult: 'restore-connection',
    })

    expect(second).toBe(first)
    expect(refreshes).toHaveLength(1)

    refreshes[0]?.resolve('keep-connection')
    await nextMicrotask()

    expect(refreshes).toHaveLength(2)
    expect(optionsSeen[1]).toEqual({
      authMode: 'single-auth-check',
      successResult: 'restore-connection',
    })

    refreshes[1]?.resolve('restore-connection')
    await expect(first).resolves.toBe('restore-connection')
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

  test('resets the stopped connection only on a successful single check', async () => {
    await expect(
      runCommentRefreshWithAuthRecovery({
        runAttempt: createAttemptSequence('success').run,
        waitBeforeRetry: async () => {
          throw new Error('single checks should not retry')
        },
        authMode: 'single-auth-check',
        successResult: 'restore-connection',
      }),
    ).resolves.toBe('restore-connection')
  })

  test('does not retry when a stopped connection still returns an auth error', async () => {
    const attempts = createAttemptSequence('auth-error')
    let waits = 0

    await expect(
      runCommentRefreshWithAuthRecovery({
        runAttempt: attempts.run,
        waitBeforeRetry: async () => {
          waits += 1
          return true
        },
        authMode: 'single-auth-check',
        successResult: 'restore-connection',
      }),
    ).resolves.toBe('close-connection')

    expect(attempts.count()).toBe(1)
    expect(waits).toBe(0)
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
  promise: Promise<
    'keep-connection' | 'close-connection' | 'restore-connection'
  >
  resolve: (
    result: 'keep-connection' | 'close-connection' | 'restore-connection',
  ) => void
}

function createDeferredRefresh(): DeferredRefresh {
  let resolve: DeferredRefresh['resolve'] | null = null
  const promise = new Promise<
    'keep-connection' | 'close-connection' | 'restore-connection'
  >((innerResolve) => {
    resolve = innerResolve
  })
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
