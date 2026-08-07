import { env } from 'cloudflare:workers'
import { Link, useOutletContext } from 'react-router'
import type { Route } from './+types/usage'
import type { SettingsLayoutContext } from './_layout'
import { SettingsPage } from '~/components/form/settings-page'
import { Button } from '~/components/ui/button'
import { StorageMeter } from '~/components/form/storage-meter'
import { inlineLinkClassName } from '~/components/form/settings-text-styles'
import { SettingsSection } from '~/components/form/settings-section'
import { useT } from '~/hooks/use-t'
import { formatBytes } from '~/lib/format'
import { formatPrice, type BillingCurrency } from '~/lib/billing-prices'
import { withLang } from '~/lib/connect-link'
import { formatStorageOveragePrice } from '~/lib/pricing-content'
import {
  allowsStorageOverage,
  storageQuotaForPlan,
} from '~/lib/billing-plan.server'
import { requireUser } from '~/middleware/context'
import { loadCurrentMonthOverageProjection } from '~/services/billing-usage.server'
import {
  createStripeClient,
  isBillingConfigured,
  loadSubscriptionContract,
} from '~/services/billing.server'
import { countWorkspaceContributors } from '~/services/team-management.server'
import { createDb } from '~/services/db.server'
import { TeamMutedParagraph } from '~/components/form/team-muted'
import { UsageStat, UsageStats } from './+components/usage-stats'
import { UpgradeNotice } from './+components/upgrade-notice'

export const USAGE_BILLING_DESTINATION = '/settings/billing?source=usage'

export function shouldShowUsageWarning(used: number, limit: number) {
  return (
    Number.isFinite(used) &&
    Number.isFinite(limit) &&
    limit > 0 &&
    used / limit >= 0.9
  )
}

type OverageProjectionView = {
  gb: number
  currency: BillingCurrency | null
  amount: number | null
}

type UsageLoaderData = {
  showOverageProjection: boolean
  includedBytes: number
  overageProjection: OverageProjectionView | null
  contributorCount: number | null
}

export async function loader({
  context,
}: Route.LoaderArgs): Promise<UsageLoaderData> {
  const user = requireUser(context)
  const db = createDb()
  const workspace = await db
    .selectFrom('workspaces')
    .select([
      'id',
      'plan',
      'stripe_subscription_status',
      'stripe_subscription_id',
    ])
    .where('id', '=', user.workspaceId)
    .executeTakeFirstOrThrow()

  const showOverageProjection = allowsStorageOverage(
    workspace.plan,
    workspace.stripe_subscription_status,
  )
  const includedBytes = storageQuotaForPlan(workspace.plan)

  const contributorCount =
    workspace.plan === 'team'
      ? await countWorkspaceContributors(db, workspace.id)
      : null

  if (!showOverageProjection) {
    return {
      showOverageProjection: false,
      includedBytes,
      overageProjection: null,
      contributorCount,
    }
  }

  const [projection, contract] = await Promise.all([
    loadCurrentMonthOverageProjection(db, workspace.id, new Date()),
    workspace.stripe_subscription_id && isBillingConfigured(env)
      ? loadSubscriptionContract(
          createStripeClient(env),
          env,
          workspace.stripe_subscription_id,
        )
      : Promise.resolve(null),
  ])
  const currency = contract?.currency ?? null

  return {
    showOverageProjection: true,
    includedBytes,
    overageProjection: {
      gb: projection.projectedOverageGb,
      currency,
      amount:
        currency === 'jpy'
          ? Math.round(projection.projectedOverageJpy)
          : currency === 'usd'
            ? Math.round(projection.projectedOverageUsd * 100) / 100
            : null,
    },
    contributorCount,
  }
}

function OverageCostStat({
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

export default function TeamUsagePage({ loaderData }: Route.ComponentProps) {
  const outletData = useOutletContext<SettingsLayoutContext>()
  const { t } = useT()

  const used = outletData.workspace.storageUsedBytes
  const quota = outletData.workspace.storageQuotaBytes
  const isTeam = outletData.kind === 'team'
  const showUsageWarning = shouldShowUsageWarning(used, quota)

  return (
    <SettingsPage>
      <SettingsSection
        title={t('team.usage')}
        description={t('team.usage.body')}
        actions={
          <Button asChild variant="outline" size="sm">
            <Link to={USAGE_BILLING_DESTINATION}>{t('team.billing')}</Link>
          </Button>
        }
      >
        {showUsageWarning ? (
          <div
            className="border-warning/40 bg-warning-soft rounded-[var(--r-md)] border p-3 text-sm"
            role="alert"
          >
            <p className="text-warning font-medium">
              {t('team.usage.nearLimit')}
            </p>
            <p>
              {t('team.usage.nearLimitDetails', {
                used: formatBytes(used),
                limit: formatBytes(quota),
                remaining: formatBytes(Math.max(0, quota - used)),
              })}
            </p>
            <p>
              {outletData.currentUserIsAdmin
                ? t('team.usage.nearLimitAdmin')
                : t('team.usage.nearLimitMember')}{' '}
              {outletData.currentUserIsAdmin ? (
                <Link
                  className={inlineLinkClassName}
                  to={USAGE_BILLING_DESTINATION}
                >
                  {t('team.usage.nearLimitBillingLink')}
                </Link>
              ) : null}
            </p>
          </div>
        ) : null}
        <UsageStats>
          {loaderData.showOverageProjection ? (
            <UsageStat
              label={t('team.usage.includedStorage')}
              value={formatBytes(loaderData.includedBytes)}
            />
          ) : null}
          <UsageStat
            label={t('team.usage.storageUsed')}
            value={formatBytes(used)}
          />
          <UsageStat
            label={t('team.usage.storageLimit')}
            value={formatBytes(quota)}
          >
            <StorageMeter usedBytes={used} quotaBytes={quota} />
          </UsageStat>
          {loaderData.showOverageProjection && loaderData.overageProjection ? (
            <>
              <UsageStat
                label={t('team.usage.projectedOverage')}
                value={`${loaderData.overageProjection.gb} GB`}
              />
              <OverageCostStat projection={loaderData.overageProjection} />
            </>
          ) : null}
          {loaderData.contributorCount !== null ? (
            <UsageStat
              label={t('team.usage.contributors')}
              value={loaderData.contributorCount.toString()}
            />
          ) : null}
        </UsageStats>
      </SettingsSection>

      {!isTeam ? (
        <UpgradeNotice
          titleKey="team.usage"
          isAdmin={outletData.currentUserIsAdmin}
          destination={USAGE_BILLING_DESTINATION}
        />
      ) : null}
    </SettingsPage>
  )
}
