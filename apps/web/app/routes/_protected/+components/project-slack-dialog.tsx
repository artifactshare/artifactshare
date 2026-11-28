import { ProjectSlackStatus } from './project-slack-status'
import { useEffect, useEffectEvent } from 'react'
import { useFetcher } from 'react-router'
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

export type SlackData = {
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
  const { t } = useT()
  const fetcher = useFetcher<SlackData | { intent: string; ok: true }>()
  const busy = fetcher.state !== 'idle'
  const data =
    fetcher.data && 'current' in fetcher.data ? fetcher.data : undefined
  const closeAfterClear = useEffectEvent(() => {
    onOpenChange(false)
  })
  useEffect(() => {
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
        <ProjectSlackStatus data={data} projectId={projectId} />
        {data ? (
          <DialogFooter className="sm:justify-between">
            {data.current ? (
              <Button
                type="button"
                variant="link"
                className="text-destructive h-auto p-0 underline"
                disabled={busy}
                onClick={() =>
                  fetcher.submit(
                    { intent: 'clear-slack-channel' },
                    { method: 'post', action: `/projects/${projectId}/slack` },
                  )
                }
              >
                {t('project.slack.clear')}
              </Button>
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
