import { IconLoader2 } from '@tabler/icons-react'
import { Badge } from '~/components/ui/badge'
import { Button } from '~/components/ui/button'
import { useT } from '~/hooks/use-t'
import { formatRelative } from '~/lib/datetime'
import type { SlackData } from './project-slack-dialog'

export function ProjectSlackStatus({
  data,
  projectId,
}: {
  data: SlackData | undefined
  projectId: string
}) {
  const { t, locale } = useT()
  return !data ? (
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
            data.current.requiresReauthorization ? 'destructive' : 'success'
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
  )
}
