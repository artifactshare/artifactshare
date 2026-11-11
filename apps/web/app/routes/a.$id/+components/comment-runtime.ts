export type CommentMutationSettlement = {
  clientMutationId: string
  appliedThreads: boolean
  threadId?: string
}

type ArtifactRecord = {
  leases: number
  epoch: number
  threads: Map<string, number>
  pending: Set<string>
  overlapping: boolean
  listeners: Set<(settlement: CommentMutationSettlement) => void>
}

/** Owned by a browser viewer environment, never a server module singleton.
 * Display and read leases can end while a captured mutation is still pending. */
export function createCommentRuntime(
  reportSubscriberError: (error: unknown) => void = (error) =>
    console.error('comment_runtime_subscriber_failed', error),
) {
  const artifacts = new Map<string, ArtifactRecord>()
  let epoch = 0

  const collect = (id: string, record: ArtifactRecord) => {
    if (
      artifacts.get(id) === record &&
      record.leases === 0 &&
      record.pending.size === 0
    )
      artifacts.delete(id)
  }
  const advance = (record: ArtifactRecord, threadId?: string) => {
    epoch += 1
    if (threadId) record.threads.set(threadId, epoch)
    else record.epoch = epoch
  }

  return {
    acquire(id: string) {
      let record = artifacts.get(id)
      if (!record) {
        record = {
          leases: 0,
          epoch: 0,
          threads: new Map(),
          pending: new Set(),
          overlapping: false,
          listeners: new Set(),
        }
        artifacts.set(id, record)
      }
      const captured = record
      captured.leases += 1
      let released = false
      const subscriptions = new Set<
        (settlement: CommentMutationSettlement) => void
      >()
      const assertActive = () => {
        if (released) throw new Error('Comment runtime lease released')
      }
      return {
        getEpoch(threadId: string) {
          assertActive()
          return Math.max(captured.epoch, captured.threads.get(threadId) ?? 0)
        },
        invalidate(threadId?: string) {
          assertActive()
          advance(captured, threadId)
        },
        hasPending(clientMutationId?: string) {
          assertActive()
          return clientMutationId
            ? captured.pending.has(clientMutationId)
            : captured.pending.size > 0
        },
        hasOverlap() {
          assertActive()
          return captured.overlapping
        },
        subscribe(listener: (settlement: CommentMutationSettlement) => void) {
          assertActive()
          // Each lease owns its registration even if callers reuse a listener.
          const subscription = (value: CommentMutationSettlement) =>
            listener(value)
          subscriptions.add(subscription)
          captured.listeners.add(subscription)
          return () => {
            subscriptions.delete(subscription)
            captured.listeners.delete(subscription)
          }
        },
        beginMutation(clientMutationId: string, threadId?: string) {
          assertActive()
          if (captured.pending.has(clientMutationId))
            throw new Error('Duplicate comment mutation identity')
          if (captured.pending.size > 0) captured.overlapping = true
          captured.pending.add(clientMutationId)
          advance(captured, threadId)
          let settled = false
          return {
            settle(
              result: Omit<CommentMutationSettlement, 'clientMutationId'>,
            ) {
              if (settled) return
              settled = true
              captured.pending.delete(clientMutationId)
              if (captured.pending.size === 0) captured.overlapping = false
              advance(captured, result.threadId ?? threadId)
              // Subscribers added during delivery wait for the next settlement.
              const listeners = [...captured.listeners]
              try {
                for (const listener of listeners) {
                  if (!captured.listeners.has(listener)) continue
                  try {
                    listener({ ...result, clientMutationId })
                  } catch (error) {
                    // Match browser event delivery: one subscriber must not
                    // prevent another viewer from observing the settlement.
                    try {
                      reportSubscriberError(error)
                    } catch {
                      // A broken reporter cannot block independent subscribers.
                    }
                  }
                }
              } finally {
                collect(id, captured)
              }
            },
          }
        },
        release() {
          if (released) return
          released = true
          for (const listener of subscriptions)
            captured.listeners.delete(listener)
          subscriptions.clear()
          captured.leases -= 1
          collect(id, captured)
        },
      }
    },
  }
}
