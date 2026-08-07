import { Link } from 'react-router'
import { SettingsSection } from '~/components/form/settings-section'
import { Button } from '~/components/ui/button'
import { useT } from '~/hooks/use-t'
import type { TKey } from '~/i18n/messages'
import { TeamMutedParagraph } from '~/components/form/team-muted'

export function UpgradeNotice({
  titleKey,
  isAdmin,
  destination = '/settings/billing',
}: {
  titleKey: TKey
  isAdmin: boolean
  destination?: string
}) {
  const { t } = useT()

  return (
    <SettingsSection title={t(titleKey)} description={t('team.upgrade.body')}>
      {isAdmin ? (
        <div>
          <Button asChild size="sm">
            <Link to={destination}>{t('team.upgrade.cta')}</Link>
          </Button>
        </div>
      ) : (
        <TeamMutedParagraph>{t('team.upgrade.askAdmin')}</TeamMutedParagraph>
      )}
    </SettingsSection>
  )
}
