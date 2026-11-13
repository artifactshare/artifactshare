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
        <ProjectSlackStatus data={data} projectId={projectId} />
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
