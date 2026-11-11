import {
  acquireCommentRuntime,
  withCommentRuntime,
} from './comment-runtime-browser'
import type {
  ChangeCommentThreads,
  CommentThreadPatch,
} from './comment-history'
import { useId, useState } from 'react'
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
      anchor?:
        | { kind: 'pdf-page'; pageNumber: number; versionId: string }
        | {
            locus?: { headings: string[]; block_text: string }
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
            targetPath?: string
          }
    }
  | { intent: 'reply'; threadId: string; body: string }
  | { intent: 'resolve' | 'reopen'; threadId: string }
  | {
      intent: 'update-message'
      messageId: string
      body: string
      threadId?: string
    }
  | { intent: 'delete-message'; messageId: string; threadId?: string }
  | { intent: 'delete-thread'; threadId: string }

export function advanceCommentEpoch(id: string, threadId?: string) {
  withCommentRuntime(id, (lease) => lease.invalidate(threadId))
}
export function hasPendingCommentMutation(id: string) {
  return withCommentRuntime(id, (lease) => lease.hasPending())
}
export function hasPendingCommentMutationId(id: string, mutationId: string) {
  return withCommentRuntime(id, (lease) => lease.hasPending(mutationId))
}

export function useCommentMutations({
  shareableId,
  isCurrentShareableId,
  onThreadsChange,
  showNewThreadComposer = false,
}: {
  shareableId: string
  isCurrentShareableId: (shareableId: string) => boolean
  onThreadsChange: ChangeCommentThreads
  showNewThreadComposer?: boolean
}) {
  const { t } = useT()
  const revalidator = useRevalidator()
  const toastPrefix = useId()
  const [pendingKeys, setPendingKeys] = useState<ReadonlySet<string>>(
    () => new Set(),
  )

  const mutate = async (
    payload: CommentMutationPayload,
    pendingKey?: string,
  ): Promise<boolean> => {
    const requestShareableId = shareableId
    const target =
      'messageId' in payload
        ? payload.messageId
        : 'threadId' in payload
          ? payload.threadId
          : 'new-thread'
    const errorToastId = `comment-save:${toastPrefix}:${requestShareableId}:${payload.intent}:${target}`
    const clientMutationId = createClientMutationId()
    let appliedThreads = false
    let threadId = 'threadId' in payload ? payload.threadId : undefined
    const runtime = acquireCommentRuntime(requestShareableId)
    let job: ReturnType<typeof runtime.beginMutation> | undefined
    if (pendingKey) {
      setPendingKeys((current) => new Set(current).add(pendingKey))
    }
    try {
      job = runtime.beginMutation(clientMutationId, threadId)
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
          toast.error(
            t(
              showNewThreadComposer
                ? 'comments.threadCapacityArtifact'
                : 'comments.threadCapacity',
            ),
            { id: errorToastId },
          )
          return false
        }
        if (result.body?.error?.code === 'rate-limited') {
          toast.error(
            t('comments.rateLimited', {
              seconds: result.body.error.details?.retry_after_seconds ?? 60,
            }),
            { id: errorToastId },
          )
          return false
        }
        if (result.body?.error?.code === 'version_conflict') {
          if (!isCurrentShareableId(requestShareableId)) return false
          // A PDF page comment is placed on the page, not on selected text.
          const pagePost =
            'anchor' in payload &&
            payload.anchor !== undefined &&
            'kind' in payload.anchor &&
            payload.anchor.kind === 'pdf-page'
          toast.error(
            t(
              pagePost
                ? 'comments.versionConflictPage'
                : 'comments.versionConflict',
            ),
            {
              id: errorToastId,
              action: {
                label: t('home.reload'),
                onClick: () => {
                  if (isCurrentShareableId(requestShareableId)) {
                    void revalidator.revalidate()
                  }
                },
              },
            },
          )
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
        body?.threadId ??
        body?.deletedThreadId ??
        body?.threads?.[0]?.id ??
        threadId
      if (body?.threads) {
        if (!runtime.hasOverlap()) onThreadsChange(body.threads, body)
        appliedThreads = !body.refreshRequired && !runtime.hasOverlap()
      }
      toast.dismiss(errorToastId)
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
      toast.error(t('comments.errorSave'), { id: errorToastId })
      return false
    } finally {
      job?.settle({
        appliedThreads,
        threadId,
      })
      runtime.release()
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

function createClientMutationId(): string {
  const randomUUID = globalThis.crypto?.randomUUID
  if (typeof randomUUID === 'function')
    return randomUUID.call(globalThis.crypto)
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
}
