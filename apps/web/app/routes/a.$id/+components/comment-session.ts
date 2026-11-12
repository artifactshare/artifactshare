import type { CommentThreadView } from '~/lib/comments'
import type { AnchorResolutionMessage } from '~/lib/csp-reporter'
import { COMMENT_REPLY_PAGE_LIMIT, commentPageUrl } from '~/lib/comment-page'
import {
  cfRayFrom,
  fetchJsonWithViewerTimeout,
  logViewerNetworkEvent,
  viewerFetchFailureReason,
} from '~/lib/viewer-network'
import { acquireCommentRuntime } from './comment-runtime-browser'
import type { CommentMutationSettlement } from './comment-runtime'
import {
  mergeCommentWindow,
  patchCommentThreads,
  revalidateCommentPage,
  type CommentThreadPatch,
  type CommentPageRequest,
} from './comment-history'
import { createCommentRefreshScope } from './comment-refresh-scope'
import {
  createCommentRefreshScheduler,
  isCommentAuthErrorStatus,
  runCommentRefreshWithAuthRecovery,
  waitForCommentAuthRecheck,
  type CommentRefreshAttemptOutcome,
  type CommentRefreshResult,
} from './comment-refresh'
import {
  consumeAppliedCommentMutationEcho,
  rememberAppliedCommentMutationEcho,
  type AppliedCommentMutationEchoes,
} from './comment-mutation-echo'

type RuntimeLease = ReturnType<typeof acquireCommentRuntime>
export type CommentSessionSnapshot = {
  threads: ReadonlyArray<CommentThreadView>
  failedThreadIds: ReadonlyArray<string>
  deletedThreadId?: string
}
export type CommentPageConsumerSnapshot = {
  pending: boolean
  failed: boolean
  failedRequest?: CommentPageRequest
}
export type CommentRecoveryTicket = {
  readonly owner: symbol
  readonly attachment: number
  readonly settlementRevision: number
}
export type CommentRecoveryAdoption =
  | { kind: 'applied' }
  | { kind: 'needs-revalidation' }
  | { kind: 'mutation-invalidated'; pending: boolean }
  | { kind: 'detached' }

/** Display-owned data and adoption. Socket authorization and UI state stay outside.
 * Construction is read-only: only attach/operations acquire browser resources. */
export function createCommentSession(options: {
  artifactId: string
  initialThreads: ReadonlyArray<CommentThreadView>
  currentUserId: string | null
  getCurrentUserId?: () => string | null
  getSelectedThreadId: () => string | null
  acquireRuntime?: () => RuntimeLease
  appliedEchoes?: AppliedCommentMutationEchoes
  // The adapter can requestRefresh and handle its keep/close result as usual.
  onPageAuthError?: () => void
  onMutationSettled?: (
    detail: CommentMutationSettlement,
    pending: boolean,
  ) => void
}) {
  const { artifactId, getSelectedThreadId } = options
  const acquireRuntime =
    options.acquireRuntime ?? (() => acquireCommentRuntime(artifactId))
  const owner = Symbol('comment-session')
  const scope = createCommentRefreshScope()
  const echoes = options.appliedEchoes ?? new Map<string, number>()
  const subscribers = new Set<(replaced: boolean) => void>()
  const consumers = new Set<{ flush: () => void; cleanup: () => void }>()
  const readLeases = new Set<RuntimeLease>()
  function acquireReadLease() {
    const lease = acquireRuntime()
    readLeases.add(lease)
    return {
      lease,
      release: () => {
        readLeases.delete(lease)
        lease.release()
      },
    }
  }
  let active = false
  let attachment = 0
  let generation = 0
  let runtime: RuntimeLease | null = null
  let refreshController: AbortController | null = null
  let snapshot: CommentSessionSnapshot = {
    threads: options.initialThreads,
    failedThreadIds: [],
  }
  function publish(
    threads: ReadonlyArray<CommentThreadView>,
    failedThreadIds: ReadonlyArray<string> = [],
    deletedThreadId?: string,
    force = false,
  ) {
    const replaced =
      force ||
      Boolean(deletedThreadId) ||
      JSON.stringify(threads) !== JSON.stringify(snapshot.threads)
    if (
      !replaced &&
      JSON.stringify(failedThreadIds) ===
        JSON.stringify(snapshot.failedThreadIds)
    )
      return
    snapshot = { threads, failedThreadIds, deletedThreadId }
    const currentSubscribers = [...subscribers]
    for (const subscriber of currentSubscribers) subscriber(replaced)
  }
  // The enclosing refresh lease spans the summary, selected read and all ranges.
  const fetchCommentThreads = <T>(id: string, signal: AbortSignal) =>
    fetchJsonWithViewerTimeout<T>(
      `/api/shareables/${encodeURIComponent(id)}/comments`,
      {
        headers: { accept: 'application/json' },
        signal,
      },
      { commentDiagnostic: { operation: 'summary' } },
    )

  const refreshOnce = async (): Promise<CommentRefreshResult> => {
    if (!active) return 'keep-connection'
    const requestArtifactId = artifactId
    const read = acquireReadLease()
    const readLease = read.lease
    const refreshScope = scope.snapshot()
    const seq = generation + 1
    generation = seq
    refreshController?.abort()
    const controller = new AbortController()
    refreshController = controller

    const fetchThreads = async (): Promise<CommentRefreshAttemptOutcome> => {
      // Every mutation can change the server's open-first selected membership.
      // Reconcile bounded windows, but revalidate history only for dirty threads.
      const requestThreads = () =>
        fetchCommentThreads<{
          threads?: ReadonlyArray<CommentThreadView>
        }>(requestArtifactId, controller.signal)
      const result = await requestThreads().catch((error: unknown) => {
        if (seq !== generation) return null
        logViewerNetworkEvent({
          channel: 'fetch',
          purpose: 'comments',
          state: 'failed',
          reason: viewerFetchFailureReason(error),
        })
        return null
      })
      if (seq !== generation || !active) return 'transient-error'
      const missingTarget = getSelectedThreadId()
      if (
        (!result?.response.ok || !result.body) &&
        missingTarget &&
        !snapshot.threads.some((thread) => thread.id === missingTarget)
      ) {
        scope.mark(missingTarget)
        publish(snapshot.threads, [missingTarget])
      }
      const response = result?.response
      if (!response) {
        return 'transient-error'
      }
      if (!response.ok) {
        logViewerNetworkEvent({
          channel: 'fetch',
          purpose: 'comments',
          state: 'response-error',
          status: response.status,
          cfRay: cfRayFrom(response),
        })
      }
      if (!active) {
        return 'transient-error'
      }
      if (isCommentAuthErrorStatus(response.status)) return 'auth-error'
      if (!response.ok) {
        return 'transient-error'
      }
      if (readLease.hasPending()) {
        return 'transient-error'
      }
      const body = result?.body ?? null
      if (!body) {
        return 'transient-error'
      }
      if (seq !== generation || !active || readLease.hasPending()) {
        return 'transient-error'
      }
      if (body.threads) {
        const incoming = [...body.threads]
        const failedIds = new Set<string>()
        let retainedSelectedId: string | undefined
        let deletedSelectedId: string | undefined
        const selectedId = getSelectedThreadId()
        if (
          selectedId &&
          !incoming.some((thread) => thread.id === selectedId)
        ) {
          const selected = await fetchJsonWithViewerTimeout<{
            threads: CommentThreadView[]
          }>(
            commentPageUrl(requestArtifactId, selectedId),
            {
              signal: controller.signal,
            },
            { commentDiagnostic: { operation: 'selected' } },
          ).catch(() => null)
          if (seq !== generation || !active) return 'transient-error'
          if (selectedId !== getSelectedThreadId()) {
            // Selection-specific data is obsolete; the independent summary is not.
            const currentSelected = snapshot.threads.find(
              (thread) => thread.id === getSelectedThreadId(),
            )
            if (
              currentSelected &&
              !incoming.some((thread) => thread.id === currentSelected.id)
            ) {
              incoming.push(currentSelected)
              retainedSelectedId = currentSelected.id
            }
            if (
              (getSelectedThreadId() &&
                !incoming.some(
                  (thread) => thread.id === getSelectedThreadId(),
                )) ||
              retainedSelectedId
            )
              void scheduler.request()
          } else if (
            selected?.response.status === 401 ||
            selected?.response.status === 403
          ) {
            return 'auth-error'
          } else if (selected?.response.ok && selected.body) {
            incoming.push(...selected.body.threads)
          } else if (
            selected &&
            (selected.response.status === 404 ||
              selected.response.status === 410)
          ) {
            deletedSelectedId = selectedId
          } else {
            // A targeted read is independent of the valid panel summary. Keep
            // its cached pages and draft mounted while offering an explicit retry.
            const retained = snapshot.threads.find(
              (thread) => thread.id === selectedId,
            )
            if (retained) incoming.push(retained)
            retainedSelectedId = selectedId
            failedIds.add(selectedId)
          }
        }
        const refreshed: CommentThreadView[] = []
        const currentById = new Map(
          snapshot.threads.map((thread) => [thread.id, thread]),
        )
        for (const thread of incoming) {
          if (thread.id === retainedSelectedId) {
            refreshed.push(thread)
            continue
          }
          let merged = mergeCommentWindow(currentById.get(thread.id), thread)
          const pages = refreshScope.has(thread.id)
            ? (merged.loadedPages ?? [])
            : []
          let removed = false
          let authError = false
          for (const page of pages) {
            try {
              merged = await revalidateCommentPage(
                merged,
                page,
                async (request) => {
                  if (seq !== generation || controller.signal.aborted)
                    throw new Error('Comment refresh superseded')
                  const pageResult = await fetchJsonWithViewerTimeout<{
                    threads?: CommentThreadView[]
                  }>(
                    commentPageUrl(requestArtifactId, thread.id, request),
                    {
                      signal: controller.signal,
                    },
                    { commentDiagnostic: { operation: 'page' } },
                  )
                  if (
                    pageResult.response.status === 401 ||
                    pageResult.response.status === 403
                  ) {
                    authError = true
                    throw new Error('Comment session needs recovery')
                  }
                  if (
                    pageResult.response.status === 404 ||
                    pageResult.response.status === 410
                  ) {
                    removed = true
                    throw new Error('Comment thread removed')
                  }
                  if (!pageResult.response.ok || !pageResult.body?.threads?.[0])
                    throw new Error('Comment page needs retry')
                  return pageResult.body.threads[0]
                },
              )
            } catch {
              if (seq !== generation || controller.signal.aborted)
                return 'transient-error'
              if (authError) return 'auth-error'
              if (removed) {
                failedIds.delete(thread.id)
                if (thread.id === getSelectedThreadId())
                  deletedSelectedId = thread.id
                break
              }
              // Retain this range and its retry intent, while applying independent
              // summary updates and any ranges that were successfully refreshed.
              failedIds.add(thread.id)
            }
          }
          if (!removed) refreshed.push(merged)
        }
        if (seq !== generation || readLease.hasPending())
          return 'transient-error'
        // A selection can change during any retained-range request, after the
        // selected read above. Keep a newly selected cache omitted by the summary
        // until the scheduler can authoritatively fetch it. Threads present in
        // incoming already had their result handled, including definitive removal.
        const currentSelectedId = getSelectedThreadId()
        if (
          currentSelectedId &&
          currentSelectedId !== selectedId &&
          !incoming.some((thread) => thread.id === currentSelectedId)
        ) {
          const retained = snapshot.threads.find(
            (thread) => thread.id === currentSelectedId,
          )
          if (retained) {
            refreshed.push(retained)
            retainedSelectedId = currentSelectedId
          }
          void scheduler.request()
        }
        if (failedIds.size === 0) refreshScope.complete()
        if (retainedSelectedId) scope.mark(retainedSelectedId)
        for (const id of failedIds) scope.mark(id)
        publish(refreshed, [...failedIds], deletedSelectedId)
      }
      return 'success'
    }

    const waitBeforeRetry = () =>
      waitForCommentAuthRecheck(controller.signal, () => {
        if (seq !== generation) return false
        return active
      })

    try {
      return await runCommentRefreshWithAuthRecovery({
        runAttempt: fetchThreads,
        waitBeforeRetry,
      })
    } finally {
      read.release()
      if (refreshController === controller) refreshController = null
    }
  }

  const scheduler = createCommentRefreshScheduler(refreshOnce)
  function interruptRefresh() {
    generation += 1
    refreshController?.abort()
    refreshController = null
  }
  function abortRefresh() {
    scheduler.cancelPending()
    interruptRefresh()
  }
  /** One handle per mounted thread display. Creation and target updates before
   * activation are read-only; cleanup is reversible for effect remounts. */
  function createPageConsumer({
    threadId,
    targetMessageId,
    onTargetMissing,
    onReady,
  }: {
    threadId: string
    targetMessageId?: string
    onTargetMissing?: (messageId: string) => void
    // React consumers resume queued work after their settlement render.
    onReady?: () => void
  }) {
    let enabled = false
    let target = targetMessageId
    let attemptedTarget: string | undefined
    let queued: CommentPageRequest | null = null
    let request: {
      controller: AbortController
      page: CommentPageRequest
      release: () => void
    } | null = null
    let state: CommentPageConsumerSnapshot = { pending: false, failed: false }
    const listeners = new Set<() => void>()
    const setState = (next: CommentPageConsumerSnapshot) => {
      state = next
      const currentListeners = [...listeners]
      for (const listener of currentListeners) listener()
    }
    function cancel() {
      const previous = request
      request = null
      previous?.controller.abort()
      previous?.release()
    }
    function cleanup() {
      enabled = false
      consumers.delete(consumer)
      cancel()
      queued = null
      attemptedTarget = undefined
      setState({ pending: false, failed: false })
    }
    function flush() {
      if (!enabled || !active || request || runtime!.hasPending()) return
      if (queued) void load(queued)
      else if (target && attemptedTarget !== target) {
        attemptedTarget = target
        void load({ aroundMessageId: target, limit: COMMENT_REPLY_PAGE_LIMIT })
      }
    }
    const consumer = { flush: onReady ?? flush, cleanup }
    async function load(page: CommentPageRequest): Promise<boolean> {
      if (!enabled || !active || request) return false
      if (runtime!.hasPending()) {
        queued = page
        setState({ pending: true, failed: false })
        return false
      }
      queued = null
      const read = acquireReadLease()
      const epoch = read.lease.getEpoch(threadId)
      const controller = new AbortController()
      const current = { controller, page, release: read.release }
      request = current
      const owns = () =>
        enabled && active && request === current && !controller.signal.aborted
      let succeeded = false
      const revalidate = () => {
        if (epoch !== read.lease.getEpoch(threadId)) {
          scope.mark(threadId)
          abortRefresh()
          void scheduler.request()
        }
      }
      const authError = (status: number) => {
        if (status !== 401 && status !== 403) return
        if (options.onPageAuthError) options.onPageAuthError()
        else void scheduler.request()
      }
      const remove = () => {
        const interrupted = refreshController !== null
        interruptRefresh()
        publish(
          patchCommentThreads(snapshot.threads, [], {
            threadId,
            deletedThreadId: threadId,
          }),
          snapshot.failedThreadIds,
          threadId,
        )
        if (interrupted && owns()) void scheduler.request()
        succeeded = true
        return true
      }
      setState({ pending: true, failed: false })
      try {
        if (!owns()) return false
        const result = await fetchJsonWithViewerTimeout<{
          threads: CommentThreadView[]
          page?: { through?: string }
        }>(
          commentPageUrl(artifactId, threadId, page),
          { signal: controller.signal },
          {
            requireJson: true,
            commentDiagnostic: { operation: 'page' },
          },
        )
        if (!owns()) return false
        const removed = (status: number) => status === 404 || status === 410
        if (
          removed(result.response.status) &&
          page.aroundMessageId &&
          onTargetMissing
        ) {
          const confirmation = await fetchJsonWithViewerTimeout<{
            threads: CommentThreadView[]
          }>(
            commentPageUrl(artifactId, threadId),
            { signal: controller.signal },
            {
              requireJson: true,
              commentDiagnostic: { operation: 'page' },
            },
          )
          if (!owns()) return false
          if (removed(confirmation.response.status)) return remove()
          if (
            confirmation.response.ok &&
            confirmation.body?.threads.some((row) => row.id === threadId)
          ) {
            onTargetMissing(page.aroundMessageId)
            if (!owns()) return false
            revalidate()
            succeeded = true
            return true
          }
          authError(confirmation.response.status)
          return false
        }
        if (!page.aroundMessageId && removed(result.response.status))
          return remove()
        authError(result.response.status)
        if (!owns() || !result.response.ok || !result.body?.threads)
          return false
        const adoptedPage =
          page.aroundMessageId && result.body.page?.through
            ? {
                through: result.body.page.through,
                limit: Math.max(
                  1,
                  (result.body.threads[0]?.messages.length ?? 1) - 1,
                ),
              }
            : page
        // Use current membership, never the list captured when this read began.
        // Interrupt a refresh that captured older retained ranges before adoption.
        const interrupted = refreshController !== null
        interruptRefresh()
        publish(
          patchCommentThreads(snapshot.threads, result.body.threads, {
            threadId,
            page: adoptedPage,
          }),
          snapshot.failedThreadIds,
          undefined,
          true,
        )
        if (!owns()) return false
        revalidate()
        if (interrupted && epoch === read.lease.getEpoch(threadId))
          void scheduler.request()
        succeeded = true
        return true
      } catch {
        return false
      } finally {
        read.release()
        if (request === current) {
          request = null
          setState(
            succeeded || controller.signal.aborted
              ? { pending: false, failed: false }
              : { pending: false, failed: true, failedRequest: page },
          )
          flush()
        }
      }
    }
    return {
      resume: flush,
      getSnapshot: () => state,
      subscribe(listener: () => void) {
        listeners.add(listener)
        return () => {
          listeners.delete(listener)
        }
      },
      activate() {
        if (!active) throw new Error('Comment session is detached')
        if (enabled) throw new Error('Comment page consumer already active')
        enabled = true
        consumers.add(consumer)
        flush()
        return cleanup
      },
      cleanup,
      load,
      setTarget(messageId?: string) {
        if (target === messageId) return
        target = messageId
        attemptedTarget = undefined
        if (queued?.aroundMessageId) queued = null
        if (request?.page.aroundMessageId) {
          cancel()
          setState({ pending: false, failed: false })
        }
        flush()
      },
    }
  }
  function captureRecovery(): CommentRecoveryTicket {
    if (!runtime || !active) throw new Error('Comment session is detached')
    return {
      owner,
      attachment,
      settlementRevision: runtime.getSettlementRevision(),
    }
  }
  function ownsRecovery(ticket: CommentRecoveryTicket) {
    return active && ticket.owner === owner && ticket.attachment === attachment
  }
  function isRecoveryCurrent(ticket: CommentRecoveryTicket) {
    return (
      ownsRecovery(ticket) &&
      runtime!.getSettlementRevision() === ticket.settlementRevision
    )
  }
  let retainedRecovery: {
    ticket: CommentRecoveryTicket
    rows: ReadonlyArray<CommentThreadView>
  } | null = null
  function offerRecovery(
    ticket: CommentRecoveryTicket,
    rows: ReadonlyArray<CommentThreadView>,
  ): CommentRecoveryAdoption {
    if (!ownsRecovery(ticket)) return { kind: 'detached' }
    if (!isRecoveryCurrent(ticket))
      return { kind: 'mutation-invalidated', pending: runtime!.hasPending() }
    runtime!.invalidate()
    abortRefresh()
    const current = new Map(
      snapshot.threads.map((thread) => [thread.id, thread]),
    )
    const threads = rows.map((thread) =>
      mergeCommentWindow(current.get(thread.id), thread),
    )
    const selected = getSelectedThreadId()
    if (
      threads.some((thread) => thread.loadedPages?.length) ||
      (selected && !threads.some((thread) => thread.id === selected))
    ) {
      scope.mark()
      return { kind: 'needs-revalidation' }
    }
    if (runtime!.hasPending())
      return { kind: 'mutation-invalidated', pending: true }
    publish(threads)
    return { kind: 'applied' }
  }
  return {
    createPageConsumer,
    hasPending: () => active && runtime!.hasPending(),
    getSnapshot: () => snapshot,
    subscribe(listener: (replaced: boolean) => void) {
      subscribers.add(listener)
      return () => {
        subscribers.delete(listener)
      }
    },
    attach() {
      if (active) throw new Error('Comment session already attached')
      const lease = acquireRuntime()
      runtime = lease
      active = true
      const committed = ++attachment
      const unsubscribe = lease.subscribe((detail) => {
        if (!active || committed !== attachment) return
        scope.mark(detail.threadId)
        abortRefresh()
        if (detail.appliedThreads && detail.clientMutationId.length > 0)
          rememberAppliedCommentMutationEcho(echoes, detail.clientMutationId)
        const pending = lease.hasPending()
        if (options.onMutationSettled)
          options.onMutationSettled(detail, pending)
        else if (!pending) void scheduler.request()
        const currentConsumers = [...consumers]
        for (const consumer of currentConsumers) consumer.flush()
      })
      return () => {
        if (committed !== attachment) return
        attachment += 1
        active = false
        retainedRecovery = null
        abortRefresh()
        const currentConsumers = [...consumers]
        for (const consumer of currentConsumers) consumer.cleanup()
        for (const readLease of readLeases) readLease.release()
        readLeases.clear()
        unsubscribe()
        lease.release()
        runtime = null
      }
    },
    requestRefresh: () => scheduler.request(),
    abortRefresh,
    ensureTarget() {
      const selected = getSelectedThreadId()
      if (
        !active ||
        !selected ||
        snapshot.threads.some((thread) => thread.id === selected)
      )
        return
      scope.mark(selected)
      void scheduler.request()
    },
    retryTarget() {
      if (!active) return
      for (const id of snapshot.failedThreadIds) scope.mark(id)
      const selected = getSelectedThreadId()
      if (selected) scope.mark(selected)
      void scheduler.request()
    },
    applyMutation(
      threads: ReadonlyArray<CommentThreadView>,
      patch?: CommentThreadPatch,
    ) {
      if (!active) return false
      const interrupted =
        (patch?.page || patch?.deletedThreadId) && refreshController !== null
      // Adoption invalidates the active read, but preserves an explicit queued
      // refresh. Settlement/recovery/detach still intentionally cancel the queue.
      interruptRefresh()
      publish(
        patch ? patchCommentThreads(snapshot.threads, threads, patch) : threads,
        patch ? snapshot.failedThreadIds : [],
        patch?.deletedThreadId,
        true,
      )
      if (patch?.revalidate) scope.mark(patch.threadId)
      if (interrupted || patch?.revalidate) void scheduler.request()
      return true
    },
    remoteChanged(message: {
      threadId?: string
      originMutationId?: string
      originUserId?: string
    }) {
      if (!active || !runtime) return false
      if (
        message.originMutationId &&
        message.originUserId ===
          (options.getCurrentUserId
            ? options.getCurrentUserId()
            : options.currentUserId) &&
        (runtime.hasPending(message.originMutationId) ||
          consumeAppliedCommentMutationEcho(echoes, message.originMutationId))
      )
        return false
      runtime.invalidate(message.threadId)
      scope.mark(message.threadId)
      abortRefresh()
      return true
    },
    invalidatePages() {
      if (active) runtime!.invalidate()
    },
    markAllDirty() {
      if (active) scope.mark()
    },
    captureRecovery,
    isRecoveryCurrent,
    offerRecovery,
    retainRecovery(
      ticket: CommentRecoveryTicket,
      rows: ReadonlyArray<CommentThreadView>,
    ) {
      retainedRecovery = { ticket, rows }
    },
    clearRecovery() {
      retainedRecovery = null
    },
    hasStaleRecovery: () =>
      retainedRecovery !== null && !isRecoveryCurrent(retainedRecovery.ticket),
    applyRecovery() {
      const retained = retainedRecovery
      retainedRecovery = null
      if (!retained) return false
      const result = offerRecovery(retained.ticket, retained.rows)
      return (
        result.kind === 'applied' ||
        (result.kind === 'mutation-invalidated' &&
          result.pending &&
          isRecoveryCurrent(retained.ticket))
      )
    },
    applyAnchorResults(results: AnchorResolutionMessage['results']) {
      if (!active) return
      const next = snapshot.threads.map((thread) => {
        const verdict = results.find((result) => result.threadId === thread.id)
        if (!verdict || thread.subject.kind !== 'text') return thread
        return {
          ...thread,
          subject: {
            ...thread.subject,
            state:
              verdict.state === 'attached'
                ? ('attached' as const)
                : ('orphaned' as const),
            positionState:
              verdict.state === 'checking'
                ? ('unchecked' as const)
                : verdict.state,
            checking: verdict.state === 'checking',
          },
        }
      })
      publish(next, snapshot.failedThreadIds)
    },
  }
}

export type CommentSession = ReturnType<typeof createCommentSession>
