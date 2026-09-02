import { IconChevronLeft, IconX } from '@tabler/icons-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Button } from '~/components/ui/button'
import { RadioGroup, RadioGroupItem } from '~/components/ui/radio-group'
import { SheetHeader, SheetTitle } from '~/components/ui/sheet'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '~/components/ui/tabs'
import type {
  AccessRequestScope,
  ReceivedAccessRequest,
  SentAccessRequest,
} from '~/services/access-requests.server'
import { useT } from '~/hooks/use-t'
import {
  AppSidePanel,
  type SidePanelTopbar,
} from '~/components/app/app-side-panel'

interface AccessRequestsResponse {
  received: ReceivedAccessRequest[]
  sent: SentAccessRequest[]
  receivedPendingCount: number
}

type AccessRequestError =
  | 'load'
  | 'changed'
  | 'unavailable'
  | 'limit'
  | 'action'
  | null

function AccessRequestDetail({
  request,
  scope,
  error,
  loading,
  submitting,
  onScopeChange,
  onRetry,
  onDecide,
}: {
  request: ReceivedAccessRequest
  scope: AccessRequestScope
  error: AccessRequestError
  loading: boolean
  submitting: boolean
  onScopeChange: (scope: AccessRequestScope) => void
  onRetry: () => void
  onDecide: (decision: 'approve' | 'reject') => void
}) {
  const { t } = useT()
  const lacksDecisionCapability =
    !request.canGrantArtifact && !request.canGrantProject
  const displayedError = error ?? (lacksDecisionCapability ? 'changed' : null)
  const decisionBlocked =
    submitting ||
    loading ||
    displayedError === 'load' ||
    lacksDecisionCapability
  const approvalBlocked =
    decisionBlocked ||
    displayedError === 'changed' ||
    displayedError === 'limit' ||
    lacksDecisionCapability

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto p-4">
      <div className="space-y-1">
        <p className="font-medium">{request.shareableTitle}</p>
        <p className="text-muted-foreground text-sm">
          {t('accessRequests.requester', {
            requester: request.requesterName?.trim()
              ? `${request.requesterName} (${request.requesterEmail})`
              : request.requesterEmail,
          })}
        </p>
      </div>
      <RadioGroup
        aria-label={t('accessRequests.scopeLabel')}
        value={scope}
        onValueChange={(value) => onScopeChange(value as AccessRequestScope)}
      >
        {request.canGrantArtifact && (
          <label className="border-border flex cursor-pointer gap-3 rounded-lg border p-3">
            <RadioGroupItem value="artifact" />
            <span>
              <span className="block text-sm font-medium">
                {t('accessRequests.scopeArtifact')}
              </span>
              <span className="text-muted-foreground block text-xs">
                {t('accessRequests.scopeArtifactHelp')}
              </span>
            </span>
          </label>
        )}
        {request.canGrantProject && request.projectName && (
          <label className="border-border flex cursor-pointer gap-3 rounded-lg border p-3">
            <RadioGroupItem value="project" />
            <span>
              <span className="block text-sm font-medium">
                {t('accessRequests.scopeProject', {
                  project: request.projectName,
                })}
              </span>
              <span className="text-muted-foreground block text-xs">
                {t('accessRequests.scopeProjectHelp')}
              </span>
            </span>
          </label>
        )}
      </RadioGroup>
      {displayedError === 'load' ? (
        <div className="space-y-3 text-center">
          <p className="text-destructive text-sm">
            {t('accessRequests.loadError')}
          </p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={loading}
            onClick={onRetry}
          >
            {t('accessRequests.retry')}
          </Button>
        </div>
      ) : displayedError ? (
        <div className="space-y-3">
          <p className="text-destructive text-sm">
            {lacksDecisionCapability
              ? t('accessRequests.permissionChangedError')
              : displayedError === 'changed'
                ? t('accessRequests.changedError')
                : displayedError === 'limit'
                  ? t('accessRequests.limitError')
                  : t('accessRequests.actionError')}
          </p>
          {(lacksDecisionCapability ||
            displayedError === 'changed' ||
            displayedError === 'limit') && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={loading}
              onClick={onRetry}
            >
              {t('accessRequests.retry')}
            </Button>
          )}
        </div>
      ) : null}
      <div className="mt-auto flex gap-2">
        <Button
          type="button"
          variant="outline"
          disabled={decisionBlocked}
          onClick={() => onDecide('reject')}
        >
          {t('accessRequests.reject')}
        </Button>
        <Button
          type="button"
          className="ml-auto"
          disabled={approvalBlocked}
          onClick={() => onDecide('approve')}
        >
          {t('accessRequests.approve')}
        </Button>
      </div>
    </div>
  )
}

function AccessRequestLists({
  data,
  error,
  loading,
  onRetry,
  onSelect,
}: {
  data: AccessRequestsResponse | null
  error: AccessRequestError
  loading: boolean
  onRetry: () => void
  onSelect: (id: string) => void
}) {
  const { t } = useT()

  return (
    <Tabs defaultValue="received" className="min-h-0 flex-1 gap-0">
      <TabsList variant="line" className="mx-4 mt-2">
        <TabsTrigger value="received">
          {t('accessRequests.received')}
          {data && data.receivedPendingCount > 0
            ? ` (${data.receivedPendingCount})`
            : ''}
        </TabsTrigger>
        <TabsTrigger value="sent">{t('accessRequests.sent')}</TabsTrigger>
      </TabsList>
      <TabsContent value="received" className="overflow-y-auto p-3">
        {(error === 'changed' ||
          error === 'unavailable' ||
          error === 'load') && (
          <div className="space-y-3 p-4 text-center">
            <p className="text-destructive text-sm">
              {error === 'changed'
                ? t('accessRequests.changedError')
                : error === 'unavailable'
                  ? t('accessRequests.unavailableError')
                  : t('accessRequests.loadError')}
            </p>
            {error !== 'unavailable' && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={loading}
                onClick={onRetry}
              >
                {t('accessRequests.retry')}
              </Button>
            )}
          </div>
        )}
        {data?.received.map((item) => (
          <button
            key={item.id}
            type="button"
            data-access-request-id={item.id}
            disabled={loading || error === 'load'}
            className="hover:bg-muted w-full rounded-lg p-3 text-left"
            onClick={() => onSelect(item.id)}
          >
            <span className="block truncate text-sm font-medium">
              {item.shareableTitle}
            </span>
            <span className="text-muted-foreground block truncate text-xs">
              {item.requesterName ?? item.requesterEmail}
            </span>
          </button>
        ))}
        {data &&
          data.received.length === 0 &&
          error !== 'changed' &&
          error !== 'unavailable' &&
          error !== 'load' && (
            <p className="text-muted-foreground p-4 text-center text-sm">
              {t('accessRequests.receivedEmpty')}
            </p>
          )}
      </TabsContent>
      <TabsContent value="sent" className="overflow-y-auto p-3">
        {data?.sent.map((item) => (
          <div key={item.id} className="flex items-center gap-2 p-3 text-sm">
            <span>{t('accessRequests.sentItem')}</span>
            <span className="text-muted-foreground ml-auto">
              {item.status === 'pending'
                ? t('accessRequests.status.pending')
                : item.status === 'approved'
                  ? t('accessRequests.status.approved')
                  : t('accessRequests.status.rejected')}
            </span>
          </div>
        ))}
        {data && data.sent.length === 0 && (
          <p className="text-muted-foreground p-4 text-center text-sm">
            {t('accessRequests.sentEmpty')}
          </p>
        )}
      </TabsContent>
    </Tabs>
  )
}

export function AccessRequestsSheet({
  open,
  onOpenChange,
  initialRequestId,
  onCountChange,
  topbar = 'none',
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  initialRequestId?: string | null
  onCountChange?: (count: number) => void
  topbar?: SidePanelTopbar
}) {
  const { t } = useT()
  const [data, setData] = useState<AccessRequestsResponse | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(
    initialRequestId ?? null,
  )
  const [scopeChoice, setScopeChoice] = useState<{
    contextKey: string
    value: AccessRequestScope
  } | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [activeLoadId, setActiveLoadId] = useState<number | null>(null)
  const loading = activeLoadId !== null
  const [error, setError] = useState<AccessRequestError>(null)
  const dataRef = useRef<AccessRequestsResponse | null>(null)
  const selectedIdRef = useRef(selectedId)
  const unverifiedInitialIdRef = useRef(initialRequestId ?? null)
  const loadRequestIdRef = useRef(0)
  const errorVersionRef = useRef(0)

  const replaceError = useCallback((next: AccessRequestError) => {
    errorVersionRef.current += 1
    setError(next)
  }, [])

  const load = useCallback(async () => {
    const requestId = ++loadRequestIdRef.current
    const errorVersion = errorVersionRef.current
    setActiveLoadId(requestId)
    try {
      const requestedId = unverifiedInitialIdRef.current
      const requestUrl = requestedId
        ? `/api/access-requests?request=${encodeURIComponent(requestedId)}`
        : '/api/access-requests'
      const response = await fetch(requestUrl)
      if (!response.ok) throw new Error('load-failed')
      const next = (await response.json()) as AccessRequestsResponse
      if (requestId !== loadRequestIdRef.current) return
      dataRef.current = next
      setData(next)
      onCountChange?.(next.receivedPendingCount)

      const activeId = selectedIdRef.current
      if (activeId && !next.received.some((item) => item.id === activeId)) {
        selectedIdRef.current = null
        setSelectedId(null)
        if (unverifiedInitialIdRef.current === activeId) {
          unverifiedInitialIdRef.current = null
          replaceError('unavailable')
        } else {
          replaceError('changed')
        }
      } else {
        if (unverifiedInitialIdRef.current === activeId) {
          unverifiedInitialIdRef.current = null
        }
        if (errorVersion === errorVersionRef.current) setError(null)
      }
    } catch {
      if (requestId === loadRequestIdRef.current) {
        replaceError('load')
      }
    } finally {
      setActiveLoadId((current) => (current === requestId ? null : current))
    }
  }, [onCountChange, replaceError])

  useEffect(() => {
    if (!open) return
    replaceError(null)
    void load()
    return () => {
      loadRequestIdRef.current += 1
    }
  }, [load, open, replaceError])

  const selected = data?.received.find((item) => item.id === selectedId)
  const scopeContextKey = selected
    ? [
        selected.id,
        selected.projectId,
        selected.canGrantArtifact,
        selected.canGrantProject,
      ].join(':')
    : ''
  const scope =
    scopeChoice?.contextKey === scopeContextKey
      ? scopeChoice.value
      : selected?.canGrantArtifact
        ? 'artifact'
        : 'project'

  const decide = async (decision: 'approve' | 'reject') => {
    if (!selected) return
    const decidedId = selected.id
    setSubmitting(true)
    replaceError(null)
    try {
      const response = await fetch(`/api/access-requests/${selected.id}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          decision,
          scope,
          expectedProjectId: selected.projectId,
        }),
      })
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as {
          error?: { code?: string }
        } | null
        if (selectedIdRef.current === decidedId) {
          replaceError(
            body?.error?.code === 'too-many-grants'
              ? 'limit'
              : response.status === 409
                ? 'changed'
                : 'action',
          )
        }
        return
      }
      const result = (await response.json().catch(() => null)) as {
        receivedPendingCount?: unknown
      } | null
      const current = dataRef.current
      if (current) {
        const wasPending = current.received.some(
          (item) => item.id === decidedId,
        )
        const nextCount =
          typeof result?.receivedPendingCount === 'number'
            ? result.receivedPendingCount
            : wasPending
              ? Math.max(0, current.receivedPendingCount - 1)
              : current.receivedPendingCount
        const nextData = {
          ...current,
          received: current.received.filter((item) => item.id !== decidedId),
          receivedPendingCount: nextCount,
        }
        dataRef.current = nextData
        setData(nextData)
        onCountChange?.(nextCount)
      }
      if (selectedIdRef.current === decidedId) {
        unverifiedInitialIdRef.current = null
        selectedIdRef.current = null
        setSelectedId(null)
      }
      void load()
    } catch {
      if (selectedIdRef.current === decidedId) replaceError('action')
    } finally {
      setSubmitting(false)
    }
  }

  const clearDecisionError = () => {
    if (error !== 'load') replaceError(null)
  }

  const retryLoad = () => {
    void load()
  }

  const backToList = () => {
    clearDecisionError()
    unverifiedInitialIdRef.current = null
    selectedIdRef.current = null
    setSelectedId(null)
  }

  return (
    <AppSidePanel
      open={open}
      onOpenChange={onOpenChange}
      topbar={topbar}
      side="right"
    >
      <SheetHeader>
        <div className="flex min-w-0 items-center gap-2">
          {selected && (
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={t('accessRequests.back')}
              disabled={submitting}
              onClick={backToList}
            >
              <IconChevronLeft aria-hidden="true" />
            </Button>
          )}
          <SheetTitle>{t('accessRequests.title')}</SheetTitle>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={t('common.close')}
          onClick={() => onOpenChange(false)}
        >
          <IconX aria-hidden="true" />
        </Button>
      </SheetHeader>

      {selected ? (
        <AccessRequestDetail
          request={selected}
          scope={scope}
          error={error}
          loading={loading}
          submitting={submitting}
          onScopeChange={(value) =>
            setScopeChoice({ contextKey: scopeContextKey, value })
          }
          onRetry={retryLoad}
          onDecide={(decision) => void decide(decision)}
        />
      ) : (
        <AccessRequestLists
          data={data}
          error={error}
          loading={loading}
          onRetry={retryLoad}
          onSelect={(id) => {
            clearDecisionError()
            unverifiedInitialIdRef.current = null
            selectedIdRef.current = id
            setSelectedId(id)
          }}
        />
      )}
    </AppSidePanel>
  )
}
