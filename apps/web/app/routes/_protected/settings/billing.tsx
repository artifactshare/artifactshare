import { env } from 'cloudflare:workers'
import { useEffect, useState } from 'react'
import {
  Form,
  Link,
  redirect,
  useFetcher,
  useNavigation,
  useSearchParams,
} from 'react-router'
import { BillingSelection } from '~/components/app/billing-toggle'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '~/components/ui/alert-dialog'
import {
  BILLING_PRICES,
  formatPrice,
  PLAN_DISPLAY,
  PLAN_PROJECT_LIMITS,
  PLAN_STORAGE_QUOTA_BYTES,
} from '~/lib/billing-prices'
import { formatStorageOveragePrice } from '~/lib/pricing-content'
import { withLang } from '~/lib/connect-link'
import { useHydrated } from '~/hooks/use-hydrated'
import { PlanCard } from '~/components/app/plan-card'
import { SettingsPage } from '~/components/form/settings-page'
import { SettingsBanner } from './+components/settings-banner'
import { BillingPlanGrid } from './+components/billing-plan-grid'
import { BillingPlans } from './+components/billing-plans'
import { TeamMutedParagraph } from '~/components/form/team-muted'
import {
  inlineLinkClassName,
  settingsSubheadingClassName,
  statLabelClassName,
} from '~/components/form/settings-text-styles'
import { StorageMeter } from '~/components/form/storage-meter'
import { UsageStat, UsageStats } from './+components/usage-stats'
import { Badge } from '~/components/ui/badge'
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '~/components/ui/card'
import { Button } from '~/components/ui/button'
import { SettingsSection } from '~/components/form/settings-section'
import { SettingsSubsection } from '~/components/form/settings-subsection'
import type { Route } from './+types/billing'
import { useT } from '~/hooks/use-t'
import { stringValue } from '~/lib/form'
import { getLocale } from '~/lib/i18n.server'
import { requireUser } from '~/middleware/context'
import {
  createCheckoutSession,
  createPortalSession,
  createStripeClient,
  changePlan,
  hasActiveSubscription,
  isBillingConfigured,
  loadSubscriptionContract,
  parseCheckoutCurrency,
  resolveCheckoutCurrency,
  type BillingInterval,
  type CheckoutCurrency,
  type CheckoutPlan,
  type PlanChangePreview,
  type SubscriptionContract,
  resolveMonthlyEstimate,
  type MonthlyEstimate,
} from '~/services/billing.server'
import { loadCurrentMonthOverageProjection } from '~/services/billing-usage.server'
import { allowsStorageOverage } from '~/lib/billing-plan.server'
import { createDb } from '~/services/db.server'
import { requireWorkspaceBillingOwner } from '~/services/team-management.server'
import { formatBytes } from '~/lib/format'
import { pricingCopyForBilling } from '~/lib/pricing-content'
import { isExternalPostingEnabledForWorkspace } from '~/lib/project-external-posting.server'
import { normalizePlan, projectLimitForPlan } from '~/lib/billing-plan.server'
import { countActiveProjects } from '~/services/projects.server'
import { isDevScreenStateRequest } from '~/services/dev-screen-state.server'

type BillingLoaderData = {
  canManage: boolean
  plan: string
  stripeSubscriptionStatus: string
  hasSubscription: boolean
  billingConfigured: boolean
  defaultCurrency: CheckoutCurrency
  initialPlan: CheckoutPlan
  initialInterval: BillingInterval
  storageUsedBytes: number
  storageQuotaBytes: number
  activeProjectCount: number
  projectLimit: number | null
  entryContext: 'default' | 'projectLimit' | 'usage' | 'plusOverage'
  externalPostingEnabled: boolean
  contract: SubscriptionContract | null
  monthlyEstimate: MonthlyEstimate | null
}

export async function loader({
  context,
  request,
}: Route.LoaderArgs): Promise<BillingLoaderData> {
  const user = requireUser(context)
  const db = createDb()

  const workspace = await db
    .selectFrom('workspaces')
    .select([
      'plan',
      'stripe_subscription_status',
      'stripe_subscription_id',
      'storage_used_bytes',
      'storage_quota_bytes',
    ])
    .where('id', '=', user.workspaceId)
    .executeTakeFirstOrThrow()

  const hasSubscription = Boolean(
    workspace.stripe_subscription_id &&
    hasActiveSubscription(workspace.stripe_subscription_status),
  )
  const billingConfigured = isBillingConfigured(env)
  // 非オーナーの閲覧で Stripe を呼ばないよう、認可を確定してから契約を取得する。
  const billingAuthorization = await requireWorkspaceBillingOwner(db, user)
  const canManage = billingAuthorization.kind === 'ok'
  const useDevFixture =
    canManage && isDevScreenStateRequest(request, 'settings-billing/subscribed')
  const devContract: SubscriptionContract = {
    plan: 'team',
    interval: 'monthly',
    currency: 'usd',
    amount: 20,
    renewsAt: '2030-01-01T00:00:00.000Z',
    cancelAtPeriodEnd: false,
  }
  const [activeProjectCount, externalPostingEnabled, contract] =
    await Promise.all([
      countActiveProjects(db, user.workspaceId),
      isExternalPostingEnabledForWorkspace(db, user.workspaceId),
      useDevFixture
        ? devContract
        : canManage &&
            hasSubscription &&
            billingConfigured &&
            workspace.stripe_subscription_id
          ? loadSubscriptionContract(
              createStripeClient(env),
              env,
              workspace.stripe_subscription_id,
            )
          : Promise.resolve(null),
    ])

  // projection と計上判定で月境界をまたがないよう同じ時刻を使う。
  const estimateNow = new Date()
  const projection =
    canManage && contract
      ? await loadCurrentMonthOverageProjection(
          db,
          user.workspaceId,
          estimateNow,
        ).catch(() => null)
      : null
  const monthlyEstimate = resolveMonthlyEstimate(
    contract,
    projection,
    estimateNow,
    allowsStorageOverage(workspace.plan, workspace.stripe_subscription_status),
  )

  const query = new URL(request.url).searchParams
  const initialPlan =
    query.get('plan') === 'plus' || query.get('plan') === 'team'
      ? (query.get('plan') as CheckoutPlan)
      : 'team'
  const initialInterval =
    query.get('interval') === 'yearly'
      ? ('yearly' as const)
      : ('monthly' as const)
  const initialCurrency =
    parseCheckoutCurrency(query.get('currency')) ??
    resolveCheckoutCurrency(request.cf?.country)
  const normalizedPlan = normalizePlan(workspace.plan)
  const storageQuotaBytes = workspace.storage_quota_bytes
  const entryContext =
    query.get('reason') === 'project_limit'
      ? ('projectLimit' as const)
      : query.get('source') === 'usage'
        ? ('usage' as const)
        : normalizedPlan === 'plus' &&
            workspace.storage_used_bytes > storageQuotaBytes
          ? ('plusOverage' as const)
          : ('default' as const)
  return {
    canManage,
    plan: workspace.plan,
    stripeSubscriptionStatus: workspace.stripe_subscription_status,
    hasSubscription,
    billingConfigured,
    defaultCurrency: initialCurrency,
    initialPlan,
    initialInterval,
    storageUsedBytes: workspace.storage_used_bytes,
    storageQuotaBytes,
    activeProjectCount,
    projectLimit: projectLimitForPlan(normalizedPlan),
    entryContext,
    externalPostingEnabled,
    contract,
    monthlyEstimate,
  }
}

export async function action({ request, context }: Route.ActionArgs) {
  const user = requireUser(context)
  const db = createDb()
  const authorized = await requireWorkspaceBillingOwner(db, user)
  if (authorized.kind !== 'ok') {
    return redirect(`/settings/billing?status=${authorized.kind}`)
  }

  const form = await request.formData()
  const intent = stringValue(form.get('intent'))
  // Vite dev のプロキシ経由では request.url の origin がポートを落とすため、
  // Stripe への戻り先 URL は BETTER_AUTH_URL を正とする。
  const origin = env.BETTER_AUTH_URL ?? new URL(request.url).origin

  if (!isBillingConfigured(env)) {
    return redirect('/settings/billing?status=billing-unavailable')
  }

  if (!env.STRIPE_SECRET_KEY) {
    console.error('billing_stripe_secret_missing')
    return redirect('/settings/billing?status=external-failed')
  }

  const workspace = await db
    .selectFrom('workspaces')
    .select([
      'id',
      'plan',
      'stripe_customer_id',
      'stripe_subscription_id',
      'stripe_subscription_status',
    ])
    .where('id', '=', user.workspaceId)
    .executeTakeFirstOrThrow()

  const stripe = createStripeClient(env)

  if (intent === 'checkout') {
    const plan = parseCheckoutPlan(stringValue(form.get('plan')))
    const interval = parseBillingInterval(stringValue(form.get('interval')))
    if (!plan || !interval) {
      return redirect('/settings/billing?status=invalid')
    }

    const currencyField = stringValue(form.get('currency'))
    let currency: CheckoutCurrency
    if (currencyField === null) {
      currency = resolveCheckoutCurrency(request.cf?.country)
    } else {
      const parsedCurrency = parseCheckoutCurrency(currencyField)
      if (!parsedCurrency) {
        return redirect('/settings/billing?status=invalid')
      }
      currency = parsedCurrency
    }
    const locale = getLocale(request, user.locale)
    const result = await createCheckoutSession(
      db,
      stripe,
      env,
      workspace,
      plan,
      interval,
      origin,
      currency,
      locale,
    )
    if (result.kind === 'ok') return redirect(result.url)
    return redirect(`/settings/billing?status=${result.kind}`)
  }

  if (intent === 'portal') {
    if (!workspace.stripe_customer_id) {
      return redirect('/settings/billing?status=invalid')
    }
    const result = await createPortalSession(
      stripe,
      env,
      workspace.stripe_customer_id,
      origin,
    )
    if (result.kind === 'ok') return redirect(result.url)
    return redirect(`/settings/billing?status=${result.kind}`)
  }

  if (intent === 'change-plan') {
    const plan = parseCheckoutPlan(stringValue(form.get('plan')))
    const interval = parseBillingInterval(stringValue(form.get('interval')))
    if (!plan || !interval) {
      return redirect('/settings/billing?status=invalid')
    }

    const result = await changePlan(stripe, env, workspace, plan, interval)
    if (result.kind === 'ok') return redirect(result.url)
    return redirect(`/settings/billing?status=${result.kind}`)
  }

  return redirect('/settings/billing?status=invalid')
}

export default function BillingPage({ loaderData }: Route.ComponentProps) {
  const navigation = useNavigation()
  const [searchParams] = useSearchParams()
  const { t, locale } = useT()
  const pendingIntent = navigation.formData?.get('intent')
  const isPending = Boolean(
    navigation.formAction === '/settings/billing' && pendingIntent,
  )
  const awaitingCheckoutReflection =
    searchParams.get('status') === 'checkout-success' &&
    loaderData.plan !== 'plus' &&
    loaderData.plan !== 'team'

  const planLabel = planDisplayName(loaderData.plan, t)

  return (
    <SettingsPage>
      {loaderData.stripeSubscriptionStatus === 'past_due' ? (
        <SettingsBanner role="alert">
          {t('billing.pastDue.banner')}
        </SettingsBanner>
      ) : null}

      <SettingsSection
        title={t('billing.title')}
        description={
          loaderData.canManage ? t('billing.body') : t('billing.readOnly.body')
        }
      >
        <SettingsSubsection title={t('billing.currentPlan')}>
          <CurrentPlanCard
            plan={planLabel}
            status={loaderData.stripeSubscriptionStatus}
            hasSubscription={loaderData.hasSubscription}
            canManage={loaderData.canManage}
            contract={loaderData.contract}
            isPending={isPending}
            storageUsedBytes={loaderData.storageUsedBytes}
            activeProjectCount={loaderData.activeProjectCount}
          />
          {shouldShowBillingContext({
            canManage: loaderData.canManage,
            plan: loaderData.plan,
            entryContext: loaderData.entryContext,
          }) ? (
            <TeamMutedParagraph>
              {t(`billing.context.${loaderData.entryContext}`, {
                current: loaderData.activeProjectCount,
                limit: loaderData.projectLimit ?? t('billing.usage.unlimited'),
              })}
            </TeamMutedParagraph>
          ) : null}

          {loaderData.canManage ? (
            loaderData.billingConfigured ? (
              loaderData.hasSubscription ? (
                <SubscribedActions
                  isPending={isPending}
                  contract={loaderData.contract}
                />
              ) : awaitingCheckoutReflection ? (
                <CheckoutPendingNotice />
              ) : (
                <CheckoutActions
                  isPending={isPending}
                  defaultCurrency={loaderData.defaultCurrency}
                  initialPlan={loaderData.initialPlan}
                  initialInterval={loaderData.initialInterval}
                  locale={locale}
                  externalPostingEnabled={loaderData.externalPostingEnabled}
                />
              )
            ) : (
              <BillingUnavailableNotice />
            )
          ) : (
            <ReadOnlyNotice />
          )}
        </SettingsSubsection>
        {loaderData.monthlyEstimate ? (
          <section>
            <MonthlyEstimate estimate={loaderData.monthlyEstimate} />
          </section>
        ) : null}
        {loaderData.canManage ? (
          <SettingsSubsection title={t('billing.usage.storageTitle')}>
            <UsageStats columns={2}>
              <UsageStat
                label={t('team.usage.storageUsed')}
                value={formatBytes(loaderData.storageUsedBytes)}
              />
              <UsageStat
                label={t('team.usage.storageLimit')}
                value={formatBytes(loaderData.storageQuotaBytes)}
              >
                <StorageMeter
                  usedBytes={loaderData.storageUsedBytes}
                  quotaBytes={loaderData.storageQuotaBytes}
                />
              </UsageStat>
            </UsageStats>
            <Link className={inlineLinkClassName} to="/settings/usage">
              {t('billing.usage.storageLink')}
            </Link>
          </SettingsSubsection>
        ) : null}
      </SettingsSection>
    </SettingsPage>
  )
}

function ReadOnlyNotice() {
  const { t } = useT()

  return (
    <TeamMutedParagraph>
      {t('billing.readOnly.seeGeneral')}{' '}
      <Link className={inlineLinkClassName} to="/settings/general">
        {t('billing.readOnly.generalLink')}
      </Link>
    </TeamMutedParagraph>
  )
}

function subscriptionBadgeVariant(
  status: string,
): 'success' | 'info' | 'warning' | 'muted' {
  if (status === 'active') return 'success'
  if (status === 'trialing') return 'info'
  if (status === 'past_due') return 'warning'
  return 'muted'
}

function CurrentPlanCard({
  plan,
  status,
  hasSubscription,
  canManage,
  contract,
  isPending,
  storageUsedBytes,
  activeProjectCount,
}: {
  plan: string
  status: string
  hasSubscription: boolean
  canManage: boolean
  contract: SubscriptionContract | null
  isPending: boolean
  storageUsedBytes: number
  activeProjectCount: number
}) {
  const { locale, t } = useT()
  const hydrated = useHydrated()
  const renewsAtLabel = contract?.renewsAt
    ? hydrated
      ? new Date(contract.renewsAt).toLocaleDateString(
          locale === 'ja' ? 'ja-JP' : 'en-US',
        )
      : contract.renewsAt.slice(0, 10)
    : null
  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle className="flex items-center gap-[var(--spacing-2)]">
          {hasSubscription && contract
            ? t(`billing.plan.${contract.plan}`)
            : plan}
          <Badge variant={subscriptionBadgeVariant(status)}>
            {subscriptionStatusLabel(status, t)}
          </Badge>
        </CardTitle>
        {contract ? (
          <CardDescription>
            {contract.currency && contract.amount !== null ? (
              <>
                {priceWithInterval(
                  t,
                  formatPrice(contract.currency, contract.amount),
                  contract.interval,
                )}
                {renewsAtLabel ? ' · ' : null}
              </>
            ) : null}
            {renewsAtLabel ? (
              <>
                {t(
                  contract.cancelAtPeriodEnd
                    ? 'billing.contract.endsAt'
                    : 'billing.contract.renewsAt',
                )}{' '}
                {renewsAtLabel}
              </>
            ) : null}
            {(contract.currency && contract.amount !== null) ||
            renewsAtLabel ? (
              <br />
            ) : null}
            {t('billing.contract.taxNote')}
          </CardDescription>
        ) : null}
      </CardHeader>
      {canManage && contract ? (
        <CardContent>
          <ChangeContract
            contract={contract}
            isPending={isPending}
            storageUsedBytes={storageUsedBytes}
            activeProjectCount={activeProjectCount}
          />
        </CardContent>
      ) : null}
      {canManage && contract ? (
        <CardFooter>
          <PortalForm isPending={isPending} />
        </CardFooter>
      ) : null}
    </Card>
  )
}

function MonthlyEstimate({ estimate }: { estimate: MonthlyEstimate }) {
  const { t, locale } = useT()
  const hydrated = useHydrated()
  const date = hydrated
    ? new Date(estimate.planDate).toLocaleDateString(
        locale === 'ja' ? 'ja-JP' : 'en-US',
      )
    : '—'
  const price = (amount: number) => formatPrice(estimate.currency, amount)
  const overageRate = formatStorageOveragePrice(estimate.currency)
  // SettingsSection owns the sibling gap; this card must not add a second mb-6.
  return (
    <Card size="sm">
      <CardHeader>
        <h3 className={settingsSubheadingClassName}>
          {t('billing.estimate.title')}
        </h3>
      </CardHeader>
      <CardContent>
        <div className="divide-border divide-y">
          <EstimateRow
            label={t('billing.estimate.plan')}
            note={
              estimate.planCharge === 'billed'
                ? t('billing.estimate.planBilled', { date })
                : estimate.planCharge === 'upcoming'
                  ? t('billing.estimate.planUpcoming', { date })
                  : estimate.cancelAtPeriodEnd
                    ? t('billing.estimate.noChargeCancel', { date })
                    : t('billing.estimate.noCharge', { date })
            }
            value={
              estimate.planCharge === 'none' ? '—' : price(estimate.planAmount)
            }
          />
          {estimate.overageEnabled ? (
            <EstimateRow
              label={t('billing.estimate.overage')}
              note={t('billing.estimate.overageNote', {
                gb: estimate.overageGb,
                rate: overageRate,
              })}
              value={price(estimate.overageAmount)}
            />
          ) : null}
          <EstimateRow
            label={t('billing.estimate.total')}
            note={t('billing.estimate.taxExcluded')}
            value={price(estimate.totalAmount)}
            total
          />
        </div>
      </CardContent>
    </Card>
  )
}

function EstimateRow({
  label,
  note,
  value,
  total = false,
}: {
  label: string
  note: string
  value: string
  total?: boolean
}) {
  return (
    <div
      // These rows form one divided breakdown; only each row's upper border
      // is intentionally flush with the preceding row.
      data-gap-audit-allow-touch
      className={`flex items-center justify-between gap-[var(--spacing-4)] py-[var(--spacing-3)] ${total ? 'bg-muted px-[var(--spacing-3)] font-semibold' : ''}`}
    >
      <div>
        <div>{label}</div>
        <div className={statLabelClassName}>{note}</div>
      </div>
      <div className="shrink-0">{value}</div>
    </div>
  )
}

function CheckoutPendingNotice() {
  const { t } = useT()

  return (
    <TeamMutedParagraph>{t('billing.checkout.pending')}</TeamMutedParagraph>
  )
}

function BillingUnavailableNotice() {
  const { t } = useT()

  return <TeamMutedParagraph>{t('billing.unavailable')}</TeamMutedParagraph>
}

export function shouldShowBillingContext({
  canManage,
  plan,
  entryContext,
}: {
  canManage: boolean
  plan: string
  entryContext: BillingLoaderData['entryContext']
}): boolean {
  if (!canManage || plan === 'team') return false
  return plan !== 'plus' || entryContext !== 'default'
}

export function CheckoutActions({
  isPending,
  defaultCurrency,
  initialPlan,
  initialInterval,
  locale,
  externalPostingEnabled,
}: {
  isPending: boolean
  defaultCurrency: CheckoutCurrency
  initialPlan: CheckoutPlan
  initialInterval: BillingInterval
  locale: 'en' | 'ja'
  externalPostingEnabled: boolean
}) {
  const { t } = useT()
  const [currency, setCurrency] = useState(defaultCurrency)
  const [interval, setBillingInterval] =
    useState<BillingInterval>(initialInterval)
  const copy = pricingCopyForBilling(locale, externalPostingEnabled)
  const priceInterval = interval === 'monthly' ? 'month' : 'year'

  return (
    <BillingPlans>
      <h3 className={settingsSubheadingClassName}>
        {t('billing.checkout.intro')}
      </h3>
      <div className="flex flex-wrap gap-[var(--spacing-3)]">
        <BillingSelection
          copy={copy}
          currency={currency}
          interval={priceInterval}
          onCurrencyChange={setCurrency}
          onIntervalChange={(value) =>
            setBillingInterval(value === 'month' ? 'monthly' : 'yearly')
          }
        />
      </div>
      <div className="grid items-stretch gap-[var(--spacing-4)] md:grid-cols-2">
        {(['plus', 'team'] as const).map((plan) => (
          <PlanCard
            key={plan}
            plan={plan}
            currency={currency}
            interval={priceInterval}
            copy={copy}
            headingLevel="h4"
          >
            <Form method="post">
              <input type="hidden" name="intent" value="checkout" />
              <input type="hidden" name="plan" value={plan} />
              <input type="hidden" name="interval" value={interval} />
              <input type="hidden" name="currency" value={currency} />
              <Button
                type="submit"
                variant={plan === initialPlan ? 'default' : 'outline'}
                className="w-full"
                disabled={isPending}
                data-primary={plan === initialPlan}
              >
                {t(`billing.checkout.submit.${plan}`)}
              </Button>
            </Form>
          </PlanCard>
        ))}
      </div>
      <TeamMutedParagraph>
        <Link className={inlineLinkClassName} to={withLang('/pricing', locale)}>
          {t('billing.pricingLink')}
        </Link>
      </TeamMutedParagraph>
    </BillingPlans>
  )
}

function SubscribedActions({
  isPending,
  contract,
}: {
  isPending: boolean
  contract: SubscriptionContract | null
}) {
  const { t } = useT()

  return (
    <>
      {!contract ? (
        <TeamMutedParagraph>
          {t('billing.contract.unavailable')}
        </TeamMutedParagraph>
      ) : null}

      {!contract ? <PortalForm isPending={isPending} /> : null}
    </>
  )
}

function PortalForm({ isPending }: { isPending: boolean }) {
  const { t } = useT()
  return (
    <Form method="post">
      <input type="hidden" name="intent" value="portal" />
      <Button variant="outline" size="sm" type="submit" disabled={isPending}>
        {t('billing.portal')}
      </Button>
    </Form>
  )
}

function contractPrice(
  contract: Pick<SubscriptionContract, 'currency'>,
  plan: CheckoutPlan,
  interval: BillingInterval,
): string | null {
  if (!contract.currency) return null
  const amount =
    BILLING_PRICES[plan][contract.currency][
      interval === 'monthly' ? 'month' : 'year'
    ]
  return formatPrice(contract.currency, amount)
}

function priceWithInterval(
  t: ReturnType<typeof useT>['t'],
  price: string,
  interval: BillingInterval,
): string {
  return t('billing.contract.amountValue', {
    price,
    interval: t(`billing.interval.${interval}`),
  })
}

function ChangeContract({
  contract,
  isPending,
  storageUsedBytes,
  activeProjectCount,
}: {
  contract: SubscriptionContract
  isPending: boolean
  storageUsedBytes: number
  activeProjectCount: number
}) {
  const { t } = useT()
  const otherPlan: CheckoutPlan = contract.plan === 'team' ? 'plus' : 'team'
  const otherInterval: BillingInterval =
    contract.interval === 'monthly' ? 'yearly' : 'monthly'
  const planChangeLabel =
    otherPlan === 'team'
      ? t('billing.change.plan.upgrade')
      : t('billing.change.plan.downgrade')
  const intervalChangeLabel =
    otherInterval === 'yearly'
      ? t('billing.change.interval.toYearly')
      : t('billing.change.interval.toMonthly')

  return (
    <BillingPlans>
      <h3 className={settingsSubheadingClassName}>
        {t('billing.changePlan.title')}
      </h3>
      <TeamMutedParagraph>{t('billing.change.body')}</TeamMutedParagraph>
      <BillingPlanGrid>
        <ChangeContractOption
          contract={contract}
          plan={otherPlan}
          interval={contract.interval}
          label={planChangeLabel}
          isDowngrade={otherPlan === 'plus'}
          storageUsedBytes={storageUsedBytes}
          activeProjectCount={activeProjectCount}
          disabled={isPending}
        />
        <ChangeContractOption
          contract={contract}
          plan={contract.plan}
          interval={otherInterval}
          label={intervalChangeLabel}
          note={
            otherInterval === 'yearly'
              ? t('billing.checkout.yearlySaving')
              : undefined
          }
          isDowngrade={false}
          storageUsedBytes={storageUsedBytes}
          activeProjectCount={activeProjectCount}
          disabled={isPending}
        />
      </BillingPlanGrid>
    </BillingPlans>
  )
}

function ChangeContractOption({
  contract,
  plan,
  interval,
  label,
  note,
  isDowngrade,
  storageUsedBytes,
  activeProjectCount,
  disabled,
}: {
  contract: SubscriptionContract
  plan: CheckoutPlan
  interval: BillingInterval
  label: string
  note?: string
  isDowngrade: boolean
  storageUsedBytes: number
  activeProjectCount: number
  disabled: boolean
}) {
  const { locale, t } = useT()
  const [open, setOpen] = useState(false)
  const preview = useFetcher<PlanChangePreview>()
  const { load } = preview
  const newPrice = contractPrice(contract, plan, interval)

  useEffect(() => {
    if (!open) return
    const params = new URLSearchParams({ plan, interval })
    load(`/settings/billing-preview?${params}`)
  }, [open, plan, interval, load])

  const previewLoading = preview.state !== 'idle' || preview.data === undefined
  const proration =
    preview.data?.kind === 'ok' &&
    preview.data.currency &&
    preview.data.prorationAmount !== null
      ? {
          currency: preview.data.currency,
          amount: preview.data.prorationAmount,
        }
      : null
  // 符号は加算・控除の文言で表すため、金額は絶対値で表示する。
  const prorationLabel = proration
    ? formatPrice(proration.currency, Math.abs(proration.amount))
    : null
  // ダイアログは client でしか開かないので、そのままローカル日付で表示できる。
  const nextInvoiceAtLabel =
    preview.data?.kind === 'ok' && preview.data.nextInvoiceAt
      ? new Date(preview.data.nextInvoiceAt).toLocaleDateString(
          locale === 'ja' ? 'ja-JP' : 'en-US',
        )
      : null

  return (
    <>
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={disabled}
        className="h-full min-h-7 w-full flex-col py-[var(--spacing-2)] whitespace-normal"
        onClick={() => setOpen(true)}
      >
        <span className="leading-snug">{label}</span>
        {note ? (
          <span className="text-muted-foreground text-xs leading-tight">
            {note}
          </span>
        ) : null}
      </Button>
      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogContent size="sm">
          <AlertDialogHeader>
            <AlertDialogTitle>{t('billing.confirm.title')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('billing.confirm.body', {
                plan: t(`billing.plan.${plan}`),
                interval: t(`billing.interval.${interval}`),
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="flex flex-col gap-[var(--spacing-2)] text-sm">
            {newPrice ? (
              <p>
                {t('billing.confirm.newPrice', {
                  price: priceWithInterval(t, newPrice, interval),
                })}
              </p>
            ) : null}
            <TeamMutedParagraph>
              {t('billing.confirm.timing')}
            </TeamMutedParagraph>
            <TeamMutedParagraph>
              {previewLoading
                ? t('billing.confirm.previewLoading')
                : proration && prorationLabel
                  ? t(
                      proration.amount < 0
                        ? 'billing.confirm.prorationCredit'
                        : 'billing.confirm.prorationCharge',
                      { amount: prorationLabel },
                    )
                  : t('billing.confirm.previewUnavailable')}
            </TeamMutedParagraph>
            {nextInvoiceAtLabel ? (
              <TeamMutedParagraph>
                {t('billing.confirm.nextInvoiceAt', {
                  date: nextInvoiceAtLabel,
                })}
              </TeamMutedParagraph>
            ) : null}
            {isDowngrade ? (
              <DowngradeImpact
                storageUsedBytes={storageUsedBytes}
                activeProjectCount={activeProjectCount}
              />
            ) : null}
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={disabled}>
              {t('confirm.cancel')}
            </AlertDialogCancel>
            <Form method="post">
              <input type="hidden" name="intent" value="change-plan" />
              <input type="hidden" name="plan" value={plan} />
              <input type="hidden" name="interval" value={interval} />
              <AlertDialogAction type="submit" disabled={disabled}>
                {t('billing.confirm.action')}
              </AlertDialogAction>
            </Form>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}

export function DowngradeImpact({
  storageUsedBytes,
  activeProjectCount,
}: {
  storageUsedBytes: number
  activeProjectCount: number
}) {
  const { t } = useT()
  const plusQuotaBytes = PLAN_STORAGE_QUOTA_BYTES.plus
  const plusProjectLimit = PLAN_PROJECT_LIMITS.plus
  const overStorage = storageUsedBytes > plusQuotaBytes
  // プロジェクト作成は count >= limit で止まるため、上限ちょうどでも警告する。
  const overProjects =
    plusProjectLimit !== null && activeProjectCount >= plusProjectLimit

  return (
    <div className="flex flex-col gap-[var(--spacing-1)]">
      <p className="font-medium">{t('billing.downgrade.title')}</p>
      <ul className="text-muted-foreground list-disc pl-[var(--spacing-5)]">
        <li>
          {t('billing.downgrade.storage', {
            team: PLAN_DISPLAY.team.storage,
            plus: PLAN_DISPLAY.plus.storage,
          })}
        </li>
        <li>
          {t('billing.downgrade.projects', {
            limit: PLAN_DISPLAY.plus.projects,
          })}
        </li>
        <li>{t('billing.downgrade.admin')}</li>
      </ul>
      {overStorage ? (
        <p className="text-destructive" role="alert">
          {t('billing.downgrade.overStorage', {
            used: formatBytes(storageUsedBytes),
            limit: PLAN_DISPLAY.plus.storage,
          })}
        </p>
      ) : null}
      {overProjects ? (
        <p className="text-destructive" role="alert">
          {t('billing.downgrade.overProjects', {
            count: activeProjectCount,
            limit: PLAN_DISPLAY.plus.projects,
          })}
        </p>
      ) : null}
    </div>
  )
}

function parseCheckoutPlan(
  value: string | null | undefined,
): CheckoutPlan | null {
  if (value === 'plus' || value === 'team') return value
  return null
}

function parseBillingInterval(
  value: string | null | undefined,
): BillingInterval | null {
  if (value === 'monthly' || value === 'yearly') return value
  return null
}

function planDisplayName(
  plan: string,
  t: ReturnType<typeof useT>['t'],
): string {
  if (plan === 'plus') return t('billing.plan.plus')
  if (plan === 'team') return t('billing.plan.team')
  return t('billing.plan.free')
}

function subscriptionStatusLabel(
  status: string,
  t: ReturnType<typeof useT>['t'],
): string {
  if (status === 'none') return t('billing.subscription.none')
  if (status === 'active') return t('billing.subscription.active')
  if (status === 'trialing') return t('billing.subscription.trialing')
  if (status === 'past_due') return t('billing.subscription.pastDue')
  if (status === 'canceled') return t('billing.subscription.canceled')
  return t('billing.subscription.other')
}
