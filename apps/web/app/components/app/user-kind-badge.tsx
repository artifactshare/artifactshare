import { Badge } from '~/components/ui/badge'
import { useT } from '~/hooks/use-t'

export function BotBadge() {
  const { t } = useT()
  return (
    <Badge variant="outline" data-testid="bot-badge">
      {t('badge.bot')}
    </Badge>
  )
}

export function UserKindBadge({ kind }: { kind?: 'human' | 'bot' | null }) {
  if (kind !== 'bot') return null
  return <BotBadge />
}
