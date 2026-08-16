import { useEffect, useEffectEvent } from 'react'
import { useFetcher } from 'react-router'
import { IconLoader2 } from '@tabler/icons-react'
import { Badge } from '~/components/ui/badge'
import { Button } from '~/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '~/components/ui/dialog'
import { useT } from '~/hooks/use-t'
import { formatRelative } from '~/lib/datetime'

type SlackData = {
  current: {
    channelName: string
    teamName: string | null
    updatedBy: string | null
    updatedAt: string
    requiresReauthorization: boolean
  } | null
}

export function ProjectSlackDialog({
  open,
  onOpenChange,
  projectId,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  projectId: string
}) {
  if (!open) return null
  return (
    <ProjectSlackDialogContent
      onOpenChange={onOpenChange}
      projectId={projectId}
    />
  )
}

function ProjectSlackDialogContent({
  onOpenChange,
  projectId,
}: {
  onOpenChange: (open: boolean) => void
  projectId: string
}) {
  const { t, locale } = useT()
  const fetcher = useFetcher<SlackData | { intent: string; ok: true }>()
  const busy = fetcher.state !== 'idle'
  // POST 応答 ({ intent, ok }) と loader 応答 (SlackData) の union を絞る。
  const data =
    fetcher.data && 'current' in fetcher.data ? fetcher.data : undefined
  const closeAfterClear = useEffectEvent(() => {
    onOpenChange(false)
  })
  useEffect(() => {
    // 解除成功の POST 応答 ({ intent, ok }) は表示用データを持たないため、
    // 開いたままだと読込中表示に落ちる。成功したら閉じる。
    if (fetcher.data && 'ok' in fetcher.data && fetcher.data.ok)
      closeAfterClear()
  }, [fetcher.data])

  const loadOnMount = useEffectEvent(() =>
    fetcher.load(`/projects/${projectId}/slack`),
  )
  useEffect(() => {
    loadOnMount()
  }, [])

  return (
    <Dialog open onOpenChange={(value) => !busy && onOpenChange(value)}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t('project.slack.title')}</DialogTitle>
          <DialogDescription>
            {t('project.slack.description')}
          </DialogDescription>
        </DialogHeader>
        {!data ? (
          <div className="flex justify-center py-8">
            <IconLoader2
              className="size-5 animate-spin"
              aria-label={t('project.slack.loading')}
            />
          </div>
        ) : data.current ? (
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <span className="truncate font-medium">
                #{data.current.channelName.replace(/^#/, '')}
              </span>
              <Badge
                variant={
                  data.current.requiresReauthorization
                    ? 'destructive'
                    : 'success'
                }
              >
                {data.current.requiresReauthorization
                  ? t('project.slack.reauthorizationRequired')
                  : t('project.slack.active')}
              </Badge>
            </div>
            <p className="text-muted-foreground text-sm">
              {data.current.teamName ? `${data.current.teamName} · ` : ''}
              {data.current.updatedBy ?? ''} ·{' '}
              {formatRelative(data.current.updatedAt, locale)}
            </p>
          </div>
        ) : (
          <div className="space-y-4">
            <p className="text-muted-foreground text-sm">
              {t('project.slack.unconfigured')}
            </p>
            <Button asChild>
              <a href={`/projects/${projectId}/slack/install`}>
                {t('project.slack.choose')}
              </a>
            </Button>
          </div>
        )}
        {data ? (
          <DialogFooter className="sm:justify-between">
            {data.current ? (
              <button
                type="button"
                className="text-destructive text-sm underline"
                disabled={busy}
                onClick={() =>
                  fetcher.submit(
                    { intent: 'clear-slack-channel' },
                    { method: 'post', action: `/projects/${projectId}/slack` },
                  )
                }
              >
                {t('project.slack.clear')}
              </button>
            ) : (
              <span />
            )}
            <div className="flex gap-2">
              <Button
                type="button"
                variant="outline"
                onClick={() => onOpenChange(false)}
              >
                {t('project.slack.close')}
              </Button>
              {data.current ? (
                <Button asChild>
                  <a href={`/projects/${projectId}/slack/install`}>
                    {data.current.requiresReauthorization
                      ? t('project.slack.reauthorize')
                      : t('project.slack.change')}
                  </a>
                </Button>
              ) : null}
            </div>
          </DialogFooter>
        ) : null}
      </DialogContent>
    </Dialog>
  )
}
