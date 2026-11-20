import { Link } from 'react-router'
import { inlineLinkClassName } from '~/components/form/settings-text-styles'
import { useT } from '~/hooks/use-t'
import { formatPrice } from '~/lib/billing-prices'
import { withLang } from '~/lib/connect-link'
import { formatStorageOveragePrice } from '~/lib/pricing-content'
import { TeamMutedParagraph } from '~/components/form/team-muted'
import { UsageStat } from './usage-stats'
import type { OverageProjectionView } from './billing-usage.server'
export function OverageCostStat({
  projection,
}: {
  projection: OverageProjectionView
}) {
  const { locale, t } = useT()
  const pricingHref = withLang('/pricing', locale)

  return (
    <UsageStat
      label={t('team.usage.projectedOverageCost')}
      value={
        projection.currency && projection.amount !== null
          ? formatPrice(projection.currency, projection.amount)
          : '—'
      }
    >
      <TeamMutedParagraph>
        {projection.currency
          ? t('team.usage.overageRateValue', {
              rate: formatStorageOveragePrice(projection.currency),
            })
          : t('team.usage.currencyUnavailable')}{' '}
        <Link className={inlineLinkClassName} to={pricingHref}>
          {t('team.usage.pricingLink')}
        </Link>
      </TeamMutedParagraph>
    </UsageStat>
  )
}

export function shouldShowUsageWarning(used: number, limit: number) {
  return (
    Number.isFinite(used) &&
    Number.isFinite(limit) &&
    limit > 0 &&
    used / limit >= 0.9
  )
}
