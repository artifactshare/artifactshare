import { Badge } from '~/components/ui/badge'
import { useT } from '~/hooks/use-t'

/**
 * Shared bot marker. Every surface that shows a bot as actor or owner
 * (artifact view owner, comments, members page, audience lists, project
 * listings, activity subjects) renders this one component so a bot is always
 * distinguishable from a same-named human.
 */
export function BotBadge() {
  const { t } = useT()
  return (
    <Badge variant="outline" data-testid="bot-badge">
      {t('badge.bot')}
    </Badge>
  )
}

/** Convenience wrapper: renders the badge only for bot users. */
export function UserKindBadge({ kind }: { kind?: 'human' | 'bot' | null }) {
  if (kind !== 'bot') return null
  return <BotBadge />
}
