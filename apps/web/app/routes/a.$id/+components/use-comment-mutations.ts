import { CommentSyncContext } from './comment-sync-context'
import {
  acquireCommentRuntime,
  withCommentRuntime,
} from './comment-runtime-browser'
import type {
  ChangeCommentThreads,
  CommentThreadPatch,
} from './comment-history'
import { useContext, useId, useRef, useState } from 'react'
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
  const assignment = useContext(CommentSyncContext)
  const { t } = useT()
  const revalidator = useRevalidator()
  const toastPrefix = useId()
  const errorToasts = useRef(new Map<string, string>())
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
    const operationKey = `comment-save:${toastPrefix}:${requestShareableId}:${payload.intent}:${target}`
    const priorErrorToastId = errorToasts.current.get(operationKey)
    const clientMutationId = createClientMutationId()
    const showError = (
      message: string,
      action?: { label: string; onClick: () => void },
    ) => {
      const previous = errorToasts.current.get(operationKey)
      if (previous !== undefined) toast.dismiss(previous)
      const id = `${operationKey}:${clientMutationId}`
      errorToasts.current.set(operationKey, id)
      toast.error(message, { id, action })
    }
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
        {
          requireJson: true,
          parseErrorJson: true,
          commentDiagnostic: { assignment, operation: payload.intent },
        },
      )
      const response = result.response
      if (!response.ok) {
        if (result.body?.error?.code === 'thread-capacity') {
          showError(
            t(
              showNewThreadComposer
                ? 'comments.threadCapacityArtifact'
                : 'comments.threadCapacity',
            ),
          )
          return false
        }
        if (result.body?.error?.code === 'rate-limited') {
          showError(
            t('comments.rateLimited', {
              seconds: result.body.error.details?.retry_after_seconds ?? 60,
            }),
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
          showError(
            t(
              pagePost
                ? 'comments.versionConflictPage'
                : 'comments.versionConflict',
            ),
            {
              label: t('home.reload'),
              onClick: () => {
                if (isCurrentShareableId(requestShareableId)) {
                  void revalidator.revalidate()
                }
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
      // A concurrent failure owns its own notification, even for this operation.
      if (priorErrorToastId !== undefined) {
        toast.dismiss(priorErrorToastId)
        if (errorToasts.current.get(operationKey) === priorErrorToastId) {
          errorToasts.current.delete(operationKey)
        }
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
      showError(t('comments.errorSave'))
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
