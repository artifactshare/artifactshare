import type {
  ChangeCommentThreads,
  CommentThreadPatch,
} from './comment-history'
import { useState } from 'react'
import { useRevalidator } from 'react-router'
import { toast } from 'sonner'
import { useT } from '~/hooks/use-t'
import type { CommentThreadView } from '~/lib/comments'
import {
  cfRayFrom,
  fetchJsonWithViewerTimeout,
  logViewerNetworkEvent,
  viewerFetchFailureReason,
} from '~/lib/viewer-network'

export type CommentMutationPayload =
  | {
      intent: 'create-thread'
      body: string
      anchor?: {
        selectorFormat?: 'normalized-v1'
        textHash?: string
        ambiguousAtCreation?: boolean
        versionId?: string | null
        quotedText: string
        prefixText: string
        suffixText: string
        textStart: number
        textEnd: number
        cssPath: string | null
      }
    }
  | { intent: 'reply'; threadId: string; body: string }
  | { intent: 'resolve' | 'reopen'; threadId: string }
  | { intent: 'update-message'; messageId: string; body: string }
  | { intent: 'delete-message'; messageId: string }
  | { intent: 'delete-thread'; threadId: string }

const mutationEpochs = new Map<string, number>()
export function advanceCommentEpoch(id: string) {
  mutationEpochs.set(id, getCommentMutationEpoch(id) + 1)
}
export function getCommentMutationEpoch(id: string): number {
  return mutationEpochs.get(id) ?? 0
}

const activeMutationsByShareable = new Map<string, number>()
const activeMutationIdsByShareable = new Map<string, Set<string>>()
const overlappingMutationsByShareable = new Set<string>()
export const COMMENT_MUTATION_SETTLED_EVENT =
  'artifactshare:comment-mutation-settled'

export type CommentMutationSettledDetail = {
  shareableId: string
  clientMutationId: string
  appliedThreads: boolean
  threadId?: string
  requiresReconcile: boolean
}

export function hasPendingCommentMutation(shareableId: string): boolean {
  return (activeMutationsByShareable.get(shareableId) ?? 0) > 0
}

export function hasPendingCommentMutationId(
  shareableId: string,
  clientMutationId: string,
): boolean {
  return (
    activeMutationIdsByShareable.get(shareableId)?.has(clientMutationId) ??
    false
  )
}

export function useCommentMutations({
  shareableId,
  isCurrentShareableId,
  onThreadsChange,
}: {
  shareableId: string
  isCurrentShareableId: (shareableId: string) => boolean
  onThreadsChange: ChangeCommentThreads
}) {
  const { t } = useT()
  const revalidator = useRevalidator()
  const [pendingKeys, setPendingKeys] = useState<ReadonlySet<string>>(
    () => new Set(),
  )

  const mutate = async (
    payload: CommentMutationPayload,
    pendingKey?: string,
  ): Promise<boolean> => {
    const requestShareableId = shareableId
    const clientMutationId = createClientMutationId()
    let appliedThreads = false
    let threadId: string | undefined
    mutationEpochs.set(
      requestShareableId,
      getCommentMutationEpoch(requestShareableId) + 1,
    )
    incrementActiveMutation(requestShareableId, clientMutationId)
    if (pendingKey) {
      setPendingKeys((current) => new Set(current).add(pendingKey))
    }
    try {
      const result = await fetchJsonWithViewerTimeout<
        CommentThreadPatch & {
          refreshRequired?: boolean
          threads?: ReadonlyArray<CommentThreadView>
          error?: { code?: string; details?: { retry_after_seconds?: number } }
        }
      >(
        `/api/shareables/${encodeURIComponent(requestShareableId)}/comments`,
        {
          method: 'POST',
          headers: {
            accept: 'application/json',
            'content-type': 'application/json',
          },
          body: JSON.stringify({ ...payload, clientMutationId }),
        },
        { requireJson: true, parseErrorJson: true },
      )
      const response = result.response
      if (!response.ok) {
        if (result.body?.error?.code === 'thread-capacity') {
          toast.error(t('comments.threadCapacity'))
          return false
        }
        if (result.body?.error?.code === 'rate-limited') {
          toast.error(
            t('comments.rateLimited', {
              seconds: result.body.error.details?.retry_after_seconds ?? 60,
            }),
          )
          return false
        }
        if (result.body?.error?.code === 'version_conflict') {
          if (!isCurrentShareableId(requestShareableId)) return false
          toast.error(t('comments.versionConflict'), {
            action: {
              label: t('home.reload'),
              onClick: () => {
                if (isCurrentShareableId(requestShareableId)) {
                  void revalidator.revalidate()
                }
              },
            },
          })
          return false
        }
        logViewerNetworkEvent({
          channel: 'fetch',
          purpose: 'comment-mutation',
          state: 'response-error',
          status: response.status,
          cfRay: cfRayFrom(response),
        })
        throw new Error('comment mutation failed')
      }
      if (!isCurrentShareableId(requestShareableId)) return false
      const body = result.body
      threadId =
        body?.threadId ?? body?.deletedThreadId ?? body?.threads?.[0]?.id
      if (body?.threads) {
        if (!overlappingMutationsByShareable.has(requestShareableId))
          onThreadsChange(body.threads, body)
        appliedThreads =
          !body.refreshRequired &&
          !overlappingMutationsByShareable.has(requestShareableId)
      }
      return true
    } catch (error) {
      if (
        !(error instanceof Error && error.message === 'comment mutation failed')
      ) {
        logViewerNetworkEvent({
          channel: 'fetch',
          purpose: 'comment-mutation',
          state: 'failed',
          reason: viewerFetchFailureReason(error),
        })
      }
      toast.error(t('comments.errorSave'))
      return false
    } finally {
      mutationEpochs.set(
        requestShareableId,
        getCommentMutationEpoch(requestShareableId) + 1,
      )
      decrementActiveMutation(requestShareableId, {
        clientMutationId,
        appliedThreads,
        threadId,
      })
      if (pendingKey) {
        setPendingKeys((current) => {
          const next = new Set(current)
          next.delete(pendingKey)
          return next
        })
      }
    }
  }

  return { mutate, pendingKeys }
}

function incrementActiveMutation(
  shareableId: string,
  clientMutationId: string,
) {
  if ((activeMutationsByShareable.get(shareableId) ?? 0) > 0) {
    overlappingMutationsByShareable.add(shareableId)
  }
  activeMutationsByShareable.set(
    shareableId,
    (activeMutationsByShareable.get(shareableId) ?? 0) + 1,
  )
  const ids = activeMutationIdsByShareable.get(shareableId) ?? new Set()
  ids.add(clientMutationId)
  activeMutationIdsByShareable.set(shareableId, ids)
}

function decrementActiveMutation(
  shareableId: string,
  detail: Omit<
    CommentMutationSettledDetail,
    'shareableId' | 'requiresReconcile'
  >,
) {
  const ids = activeMutationIdsByShareable.get(shareableId)
  ids?.delete(detail.clientMutationId)
  if (ids?.size === 0) activeMutationIdsByShareable.delete(shareableId)

  const next = (activeMutationsByShareable.get(shareableId) ?? 0) - 1
  const requiresReconcile =
    detail.appliedThreads ||
    (next <= 0 && overlappingMutationsByShareable.has(shareableId))
  if (next > 0) {
    activeMutationsByShareable.set(shareableId, next)
  } else {
    activeMutationsByShareable.delete(shareableId)
    overlappingMutationsByShareable.delete(shareableId)
  }
  window.dispatchEvent(
    new CustomEvent(COMMENT_MUTATION_SETTLED_EVENT, {
      detail: { shareableId, ...detail, requiresReconcile },
    }),
  )
}

function createClientMutationId(): string {
  const randomUUID = globalThis.crypto?.randomUUID
  if (typeof randomUUID === 'function')
    return randomUUID.call(globalThis.crypto)
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
}
