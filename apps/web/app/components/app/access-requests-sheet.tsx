import { IconChevronLeft, IconX } from '@tabler/icons-react'
import { useCallback, useEffect, useState } from 'react'
import { Button } from '~/components/ui/button'
import { RadioGroup, RadioGroupItem } from '~/components/ui/radio-group'
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from '~/components/ui/sheet'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '~/components/ui/tabs'
import type {
  AccessRequestScope,
  ReceivedAccessRequest,
  SentAccessRequest,
} from '~/services/access-requests.server'
import { useT } from '~/hooks/use-t'

interface AccessRequestsResponse {
  received: ReceivedAccessRequest[]
  sent: SentAccessRequest[]
  receivedPendingCount: number
}

export function AccessRequestsSheet({
  open,
  onOpenChange,
  initialRequestId,
  onCountChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  initialRequestId?: string | null
  onCountChange?: (count: number) => void
}) {
  const { t } = useT()
  const [data, setData] = useState<AccessRequestsResponse | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(
    initialRequestId ?? null,
  )
  const [scope, setScope] = useState<AccessRequestScope>('artifact')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<
    'load' | 'changed' | 'limit' | 'action' | null
  >(null)

  const load = useCallback(async () => {
    const response = await fetch('/api/access-requests')
    if (!response.ok) throw new Error('load-failed')
    const next = (await response.json()) as AccessRequestsResponse
    setData(next)
    onCountChange?.(next.receivedPendingCount)
    if (
      initialRequestId &&
      next.received.some((item) => item.id === initialRequestId)
    ) {
      setSelectedId(initialRequestId)
    }
  }, [initialRequestId, onCountChange])

  useEffect(() => {
    if (!open) return
    setError(null)
    void load().catch(() => setError('load'))
  }, [load, open])

  const selected = data?.received.find((item) => item.id === selectedId)
  useEffect(() => {
    if (!selected) return
    setScope(selected.canGrantArtifact ? 'artifact' : 'project')
  }, [selected])

  const decide = async (decision: 'approve' | 'reject') => {
    if (!selected) return
    setSubmitting(true)
    setError(null)
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
        setError(
          body?.error?.code === 'too-many-grants'
            ? 'limit'
            : response.status === 409
              ? 'changed'
              : 'action',
        )
        return
      }
      setSelectedId(null)
      await load()
    } catch {
      setError('action')
    } finally {
      setSubmitting(false)
    }
  }

  const clearDecisionError = () => {
    setError((current) => (current === 'load' ? current : null))
  }

  const retryLoad = () => {
    setError(null)
    void load().catch(() => setError('load'))
  }

  return (
    <Sheet modal={false} open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="max-sheet:inset-x-2.5 max-sheet:top-auto max-sheet:bottom-0 max-sheet:h-[var(--height-comment-panel-sheet)] max-sheet:w-auto max-sheet:max-w-none max-sheet:rounded-t-[var(--r-lg)] max-sheet:border-t-divider max-sheet:border-r-divider max-sheet:border-l-divider gap-0"
      >
        <SheetHeader>
          <div className="flex min-w-0 items-center gap-2">
            {selected && (
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label={t('accessRequests.back')}
                onClick={() => {
                  clearDecisionError()
                  setSelectedId(null)
                }}
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
          <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto p-4">
            <div className="space-y-1">
              <p className="font-medium">{selected.shareableTitle}</p>
              <p className="text-muted-foreground text-sm">
                {t('accessRequests.requester', {
                  requester: selected.requesterName?.trim()
                    ? `${selected.requesterName} (${selected.requesterEmail})`
                    : selected.requesterEmail,
                })}
              </p>
            </div>
            <RadioGroup
              aria-label={t('accessRequests.scopeLabel')}
              value={scope}
              onValueChange={(value) => setScope(value as AccessRequestScope)}
            >
              {selected.canGrantArtifact && (
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
              {selected.canGrantProject && selected.projectName && (
                <label className="border-border flex cursor-pointer gap-3 rounded-lg border p-3">
                  <RadioGroupItem value="project" />
                  <span>
                    <span className="block text-sm font-medium">
                      {t('accessRequests.scopeProject', {
                        project: selected.projectName,
                      })}
                    </span>
                    <span className="text-muted-foreground block text-xs">
                      {t('accessRequests.scopeProjectHelp')}
                    </span>
                  </span>
                </label>
              )}
            </RadioGroup>
            {error === 'load' ? (
              <div className="space-y-3 text-center">
                <p className="text-destructive text-sm">
                  {t('accessRequests.loadError')}
                </p>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={retryLoad}
                >
                  {t('accessRequests.retry')}
                </Button>
              </div>
            ) : error ? (
              <p className="text-destructive text-sm">
                {error === 'changed'
                  ? t('accessRequests.changedError')
                  : error === 'limit'
                    ? t('accessRequests.limitError')
                    : t('accessRequests.actionError')}
              </p>
            ) : null}
            <div className="mt-auto flex gap-2">
              <Button
                type="button"
                variant="outline"
                disabled={submitting || error === 'load'}
                onClick={() => void decide('reject')}
              >
                {t('accessRequests.reject')}
              </Button>
              <Button
                type="button"
                className="ml-auto"
                disabled={submitting || error === 'load'}
                onClick={() => void decide('approve')}
              >
                {t('accessRequests.approve')}
              </Button>
            </div>
          </div>
        ) : (
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
              {error === 'load' && (
                <div className="space-y-3 p-4 text-center">
                  <p className="text-destructive text-sm">
                    {t('accessRequests.loadError')}
                  </p>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={retryLoad}
                  >
                    {t('accessRequests.retry')}
                  </Button>
                </div>
              )}
              {data?.received.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  disabled={error === 'load'}
                  className="hover:bg-muted w-full rounded-lg p-3 text-left"
                  onClick={() => {
                    clearDecisionError()
                    setSelectedId(item.id)
                  }}
                >
                  <span className="block truncate text-sm font-medium">
                    {item.shareableTitle}
                  </span>
                  <span className="text-muted-foreground block truncate text-xs">
                    {item.requesterName ?? item.requesterEmail}
                  </span>
                </button>
              ))}
              {data && data.received.length === 0 && (
                <p className="text-muted-foreground p-4 text-center text-sm">
                  {t('accessRequests.receivedEmpty')}
                </p>
              )}
            </TabsContent>
            <TabsContent value="sent" className="overflow-y-auto p-3">
              {data?.sent.map((item) => (
                <div
                  key={item.id}
                  className="flex items-center gap-2 p-3 text-sm"
                >
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
        )}
      </SheetContent>
    </Sheet>
  )
}
