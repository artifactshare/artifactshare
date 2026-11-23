import { useSettingsEntryChange } from '~/hooks/use-settings-entry-change'
import {
  loadUsage,
  sharedOverageProjection,
  type UsageLoaderData,
} from '../+components/billing-usage.server'
import {
  OverageCostStat,
  shouldShowUsageWarning,
} from '../+components/billing-usage'
import { env } from 'cloudflare:workers'
import { useEffect, useId, useState, type ReactNode } from 'react'
import {
  data as actionData,
  Link,
  redirect,
  useActionData,
  useFetcher,
  useLocation,
  useOutletContext,
} from 'react-router'
import { BillingSelection } from '~/components/app/billing-toggle'
import { ConfirmActionDialog } from '../+components/confirm-action-dialog'
import { settingsFailure } from '~/lib/settings-submission'
import {
  confirmationResult,
  runConfirmedMutation,
} from '~/lib/settings-confirmation'
import type { SettingsLayoutContext } from '../_layout'
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
import { SettingsBanner, StatusBanner } from '../+components/settings-banner'
import { BillingPlanGrid } from '../+components/billing-plan-grid'
import { BillingPlans } from '../+components/billing-plans'
import { TeamMutedParagraph } from '~/components/form/team-muted'
import {
  inlineLinkClassName,
  settingsSubheadingClassName,
  statLabelClassName,
} from '~/components/form/settings-text-styles'
import { StorageMeter } from '~/components/form/storage-meter'
import { UsageStat, UsageStats } from '../+components/usage-stats'
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
import { allowsStorageOverage } from '~/lib/billing-plan.server'
import { createDb } from '~/services/db.server'
import { requireWorkspaceBillingOwner } from '~/services/team-management.server'
import { formatBytes } from '~/lib/format'
import {
  isSessionExpired,
  useSignInOnSessionExpired,
  type SessionExpired,
} from '~/lib/session-expired'
import { pricingCopyForBilling } from '~/lib/pricing-content'
import {
  canUseExternalPosting,
  normalizeWorkspaceLinkPolicy,
} from '~/lib/link-sharing-policy'
import {
  settingsActiveRole,
  settingsWorkspace,
} from '../+lib/settings-request.server'
import { settingsShellShouldRevalidate } from '../+lib/shell-revalidation'
import { normalizePlan, projectLimitForPlan } from '~/lib/billing-plan.server'
import { countActiveProjects } from '~/services/projects.server'
import type { ScreenSpec } from '~/types/screen'

export const screen = {
  id: 'settings-billing',
  route: {
    en: '/settings/billing',
  },
  auth: 'team-owner',
  loop: 'support',
  metric: '適切なプラン継続を支える',
  role: '契約と請求を管理する',
  primaryAction: 'プランを管理する',
  states: [
    {
      id: 'monthly-jpy',
      description: 'monthly jpy plan cards',
      setup: {
        scenario: 'settings-billing/purchase',
        ready: {
          selector: '[data-plan="plus"]',
          description: 'Checkout plan cards are visible',
        },
        query: '?interval=monthly&currency=jpy',
      },
    },
    {
      id: 'monthly-usd',
      description: 'monthly usd plan cards',
      setup: {
        scenario: 'settings-billing/purchase',
        ready: {
          selector: '[data-plan="plus"]',
          description: 'Checkout plan cards are visible',
        },
        query: '?interval=monthly&currency=usd',
      },
    },
    {
      id: 'yearly-jpy',
      description: 'yearly jpy plan cards',
      setup: {
        scenario: 'settings-billing/purchase',
        ready: {
          selector: '[data-plan="plus"]',
          description: 'Checkout plan cards are visible',
        },
        query: '?interval=yearly&currency=jpy',
      },
    },
    {
      id: 'yearly-usd',
      description: 'yearly usd plan cards',
      setup: {
        scenario: 'settings-billing/purchase',
        ready: {
          selector: '[data-plan="plus"]',
          description: 'Checkout plan cards are visible',
        },
        query: '?interval=yearly&currency=usd',
      },
    },
    {
      id: 'past-due',
      description: 'Past-due billing warning',
      setup: {
        scenario: 'settings-billing/past-due',
        ready: {
          selector:
            'body:not(:has([data-billing-unavailable])):has([data-billing-past-due][role="alert"]) section > [data-slot="card"]:has([data-slot="card-description"]):has([data-slot="card-content"] button) form:has(input[value="portal"]) button:enabled',
          visibleWith: [
            '[data-billing-contract-details]',
            '[data-billing-change="plan"]',
            '[data-billing-change="interval"]',
            '[data-billing-past-due][role="alert"]',
          ],
          description: 'Configured past-due billing controls',
        },
      },
    },
    {
      id: 'result-success',
      description: 'Completed checkout awaiting plan sync',
      setup: {
        scenario: 'settings-billing/purchase',
        query: '?status=checkout-success',
        ready: {
          selector:
            'body:not(:has([data-billing-unavailable], [data-plan="plus"], [data-plan="team"])) [data-billing-checkout-pending]',
          visibleWith: [
            '[role="status"][data-settings-status="checkout-success"]',
          ],
          description: 'Completed checkout awaiting plan sync',
        },
      },
    },
    {
      id: 'result-warning',
      description: 'Cancelled checkout with plan cards',
      setup: {
        scenario: 'settings-billing/purchase',
        query: '?status=checkout-cancelled',
        ready: {
          selector:
            'body:not(:has([data-billing-unavailable])) [data-plan="team"]',
          visibleWith: [
            '[role="status"][data-settings-status="checkout-cancelled"]',
            '[data-plan="plus"]',
          ],
          description: 'Cancelled checkout with plan cards',
        },
      },
    },
    {
      id: 'result-error',
      description: 'Rejected checkout with plan cards',
      setup: {
        scenario: 'settings-billing/purchase',
        interactions: [
          {
            action: 'click',
            selector: '[data-plan="plus"] button[type="submit"]',
          },
        ],
        actionResponse: {
          route: '/settings/billing',
          method: 'POST',
          intent: 'checkout',
          status: 409,
          data: { ok: false, code: 'billing-unavailable', intent: 'checkout' },
        },
        postInteractionReady: {
          selector:
            'body:not(:has([data-billing-unavailable])) [data-plan="team"]',
          visibleWith: [
            '[data-plan="plus"] form [role="alert"][data-settings-status="billing-unavailable"]',
            '[data-plan="plus"]',
          ],
          description: 'Rejected checkout with plan cards',
        },
      },
    },
    {
      id: 'continuing-near-limit',
      description: 'Continuing subscription near included storage',
      setup: {
        scenario: 'settings-billing/continuing-near-limit',
        ready: {
          selector:
            'body:not(:has([data-billing-unavailable])):has(#billing-estimate-overage) section > [data-slot="card"]:has([data-slot="card-description"]):has([data-slot="card-content"] button) form:has(input[value="portal"]) button:enabled',
          visibleWith: [
            '[data-billing-contract-details]',
            '[data-billing-change="plan"]',
            '[data-billing-change="interval"]',
            '#billing-estimate-overage',
          ],
          description: 'Configured continuing-near-limit billing controls',
        },
      },
    },
    {
      id: 'near-limit',
      description: 'Storage near limit',
      setup: {
        scenario: 'settings-billing/near-limit',
        ready: {
          selector:
            'body:not(:has([data-billing-unavailable])) [data-plan="team"]',
          visibleWith: [
            '[role="alert"] [data-billing-upgrade-guidance]',
            '[data-plan="plus"]',
          ],
          description: 'Configured near-limit billing controls',
        },
      },
    },
    {
      id: 'default',
      description: '請求設定',
      setup: {
        scenario: 'settings-billing/purchase',
        ready: {
          selector:
            'body:not(:has([data-billing-unavailable], [data-billing-contract-details])) [data-plan="team"] form button[type="submit"]:enabled',
          visibleWith: [
            '[data-plan="plus"] form button[type="submit"]:enabled',
          ],
          description: 'Configured Free purchase controls',
        },
      },
    },
    {
      id: 'subscribed',
      description: '有効な Team 契約がある状態',
      setup: {
        scenario: 'settings-billing/subscribed',
        ready: {
          selector:
            'body:not(:has([data-billing-unavailable])) section > [data-slot="card"]:has([data-slot="card-description"]):has([data-slot="card-content"] button) form:has(input[value="portal"]) button:enabled',
          visibleWith: [
            '[data-billing-contract-details]',
            '[data-billing-change="plan"]',
            '[data-billing-change="interval"]',
          ],
          description: 'Configured subscribed billing controls',
        },
      },
    },
  ],
} satisfies ScreenSpec

type BillingView = UsageLoaderData & {
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

/** The plan and storage the page shows come from the Settings shell. */
type BillingLoaderData = Omit<
  BillingView,
  'plan' | 'storageUsedBytes' | 'storageQuotaBytes'
>

export async function loader({
  context,
  request,
}: Route.LoaderArgs): Promise<BillingLoaderData> {
  const user = requireUser(context)
  const db = createDb()

  // The same workspace row and active membership the Settings shell reads in
  // this request; billing-only fields stay in this response.
  const [workspace, role] = await Promise.all([
    settingsWorkspace(context),
    settingsActiveRole(context),
  ])

  const hasSubscription = Boolean(
    workspace.stripe_subscription_id &&
    hasActiveSubscription(workspace.stripe_subscription_status),
  )
  const billingConfigured = isBillingConfigured(env)
  // 契約管理用の応答はオーナーに限る。使用量は従来の Usage と同じ読み取り境界を保つ。
  const canManage = role === 'owner'
  const [activeProjectCount, externalPostingEnabled, contract] =
    await Promise.all([
      countActiveProjects(db, user.workspaceId),
      canUseExternalPosting(normalizeWorkspaceLinkPolicy(workspace)),
      canManage &&
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

  // projection と計上判定で月境界をまたがないよう同じ時刻を使う。使用量と月額見込みは
  // 同じ projection を共有する。
  const estimateNow = new Date()
  const readProjection = sharedOverageProjection(user.workspaceId, estimateNow)
  const projection = canManage && contract ? await readProjection() : null
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
    ...(await loadUsage({
      workspace,
      projection: readProjection,
      ...(canManage ? { contract } : {}),
    })),
    canManage,
    stripeSubscriptionStatus: workspace.stripe_subscription_status,
    hasSubscription,
    billingConfigured,
    defaultCurrency: initialCurrency,
    initialPlan,
    initialInterval,
    activeProjectCount,
    projectLimit: projectLimitForPlan(normalizedPlan),
    entryContext,
    externalPostingEnabled,
    contract,
    monthlyEstimate,
  }
}

// Billing reads the same workspace row as the shell, so a submission that
// keeps the shell (opening the Stripe portal) keeps billing's data too.
export const shouldRevalidate = settingsShellShouldRevalidate

export async function action({ request, context }: Route.ActionArgs) {
  const form = await request.formData()
  const intent = stringValue(form.get('intent')) ?? ''
  const submit = () => submitBilling(request, context, form, intent)
  return intent === 'change-plan' ? runConfirmedMutation(submit) : submit()
}

export async function clientAction({
  request,
  serverAction,
}: Route.ClientActionArgs) {
  const intent = (await request.clone().formData()).get('intent')
  return intent === 'change-plan'
    ? confirmationResult(intent, serverAction)
    : serverAction()
}

async function submitBilling(
  request: Request,
  context: Route.ActionArgs['context'],
  form: FormData,
  intent: string,
) {
  const user = requireUser(context)
  const db = createDb()
  const authorized = await requireWorkspaceBillingOwner(db, user)
  if (authorized.kind !== 'ok') return settingsFailure(intent, authorized.kind)
  if (!['change-plan', 'checkout', 'portal'].includes(intent))
    return settingsFailure(intent, 'invalid')
  // Vite dev のプロキシ経由では request.url の origin がポートを落とすため、
  // Stripe への戻り先 URL は BETTER_AUTH_URL を正とする。
  const origin = env.BETTER_AUTH_URL ?? new URL(request.url).origin

  if (!isBillingConfigured(env)) {
    return settingsFailure(intent, 'billing-unavailable')
  }

  if (!env.STRIPE_SECRET_KEY) {
    console.error('billing_stripe_secret_missing')
    return settingsFailure(intent, 'external-failed')
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
      return settingsFailure(intent, 'invalid')
    }

    const currencyField = stringValue(form.get('currency'))
    let currency: CheckoutCurrency
    if (currencyField === null) {
      currency = resolveCheckoutCurrency(request.cf?.country)
    } else {
      const parsedCurrency = parseCheckoutCurrency(currencyField)
      if (!parsedCurrency) {
        return settingsFailure(intent, 'invalid')
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
    return settingsFailure(intent, result.kind)
  }

  if (intent === 'portal') {
    if (!workspace.stripe_customer_id) {
      return settingsFailure(intent, 'invalid')
    }
    const result = await createPortalSession(
      stripe,
      env,
      workspace.stripe_customer_id,
      origin,
    )
    if (result.kind === 'ok') return redirect(result.url)
    return settingsFailure(intent, result.kind)
  }

  if (intent === 'change-plan') {
    const plan = parseCheckoutPlan(stringValue(form.get('plan')))
    const interval = parseBillingInterval(stringValue(form.get('interval')))
    if (!plan || !interval) {
      return settingsFailure(intent, 'invalid')
    }

    const result = await changePlan(stripe, env, workspace, plan, interval)
    if (result.kind === 'accepted')
      return actionData(
        { ok: true as const, code: 'plan-change-requested', intent },
        { status: 202 },
      )
    return settingsFailure(intent, result.kind)
  }

  return settingsFailure(intent, 'invalid')
}

export default function BillingPage({
  loaderData: billing,
}: {
  loaderData: BillingLoaderData
}) {
  const shell = useOutletContext<SettingsLayoutContext>()
  const loaderData: BillingView = {
    ...billing,
    plan: shell.workspace.plan,
    storageUsedBytes: shell.workspace.storageUsedBytes,
    storageQuotaBytes: shell.workspace.storageQuotaBytes,
  }
  // Checkout and Portal submitted before hydration report a failure here; a
  // success has already moved to Stripe.
  const nativeResult = useActionData<typeof action>()
  const { t, locale } = useT()
  const awaitingCheckoutReflection =
    shell.externalResult === 'checkout-success' &&
    !loaderData.hasSubscription &&
    loaderData.plan !== 'plus' &&
    loaderData.plan !== 'team'

  const presentation = billingPresentation(loaderData)
  const showStorageWarning =
    !loaderData.showOverageProjection &&
    shouldShowUsageWarning(
      loaderData.storageUsedBytes,
      loaderData.storageQuotaBytes,
    )
  const planLabel = planDisplayName(loaderData.plan, t)

  return (
    <SettingsPage>
      {nativeResult && !nativeResult.ok && (
        <StatusBanner status={nativeResult.code} />
      )}
      <PlanChangeNotice kind="plan" />
      <PlanChangeNotice kind="interval" />
      {loaderData.stripeSubscriptionStatus === 'past_due' ? (
        <SettingsBanner kind="warning" urgent data-billing-past-due>
          {t('billing.pastDue.banner')}
        </SettingsBanner>
      ) : null}

      <SettingsSection
        headingId="billing-heading"
        title={t('billing.title')}
        description={
          !loaderData.canManage ? t('billing.readOnly.body') : t('billing.body')
        }
      >
        <SettingsSubsection title={t('billing.currentPlan')}>
          <CurrentPlanCard
            plan={planLabel}
            status={loaderData.stripeSubscriptionStatus}
            hasSubscription={loaderData.hasSubscription}
            canManage={loaderData.canManage}
            contract={loaderData.contract}
            storageUsedBytes={loaderData.storageUsedBytes}
            activeProjectCount={loaderData.activeProjectCount}
          />
          {shouldShowBillingContext({
            awaitingCheckoutReflection,
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

          <BillingActions
            loaderData={loaderData}
            awaitingCheckoutReflection={awaitingCheckoutReflection}
          />
        </SettingsSubsection>
        {loaderData.monthlyEstimate ? (
          <section>
            <MonthlyEstimate estimate={loaderData.monthlyEstimate} />
          </section>
        ) : null}
        <BillingStorageSection
          showStorageWarning={showStorageWarning}
          loaderData={loaderData}
          presentation={presentation}
        />
      </SettingsSection>
    </SettingsPage>
  )
}

function BillingStorageSection({
  showStorageWarning,
  loaderData,
  presentation,
}: {
  showStorageWarning: boolean
  loaderData: Pick<
    BillingView,
    | keyof UsageLoaderData
    | 'storageUsedBytes'
    | 'storageQuotaBytes'
    | 'monthlyEstimate'
    | 'canManage'
    | 'billingConfigured'
  >
  presentation: ReturnType<typeof billingPresentation>
}) {
  const { t } = useT()
  return (
    <SettingsSubsection title={t('billing.usage.storageTitle')}>
      {showStorageWarning ? (
        <SettingsBanner kind="warning" urgent>
          <p className="font-medium">{t('team.usage.nearLimit')}</p>
          <p>
            {t('team.usage.nearLimitDetails', {
              used: formatBytes(loaderData.storageUsedBytes),
              limit: formatBytes(loaderData.storageQuotaBytes),
              remaining: formatBytes(
                Math.max(
                  0,
                  loaderData.storageQuotaBytes - loaderData.storageUsedBytes,
                ),
              ),
            })}
          </p>
          <NearLimitNextStep
            canManage={loaderData.canManage}
            billingConfigured={loaderData.billingConfigured}
            presentation={presentation}
          />
        </SettingsBanner>
      ) : null}
      <UsageStats columns={2}>
        <UsageStat
          label={t('team.usage.storageUsed')}
          value={formatBytes(loaderData.storageUsedBytes)}
        >
          <StorageMeter
            usedBytes={loaderData.storageUsedBytes}
            quotaBytes={
              loaderData.showOverageProjection
                ? loaderData.includedBytes
                : loaderData.storageQuotaBytes
            }
            warnNearLimit={!loaderData.showOverageProjection}
          />
        </UsageStat>
        <UsageStat
          label={t(
            loaderData.showOverageProjection
              ? 'team.usage.includedStorage'
              : 'team.usage.storageLimit',
          )}
          value={formatBytes(
            loaderData.showOverageProjection
              ? loaderData.includedBytes
              : loaderData.storageQuotaBytes,
          )}
        />
        {loaderData.overageProjection && !loaderData.monthlyEstimate ? (
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
            value={String(loaderData.contributorCount)}
          />
        ) : null}
      </UsageStats>
    </SettingsSubsection>
  )
}

function NearLimitNextStep({
  canManage,
  billingConfigured,
  presentation,
}: Pick<BillingView, 'canManage' | 'billingConfigured'> & {
  presentation: ReturnType<typeof billingPresentation>
}) {
  const { t } = useT()
  if (!canManage) return <p>{t('team.usage.nearLimitMember')}</p>
  if (billingConfigured && presentation === 'purchase')
    return <p data-billing-upgrade-guidance>{t('team.usage.nearLimitAdmin')}</p>
  return null
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
  storageUsedBytes,
  activeProjectCount,
}: {
  plan: string
  status: string
  hasSubscription: boolean
  canManage: boolean
  contract: SubscriptionContract | null
  storageUsedBytes: number
  activeProjectCount: number
}) {
  const { locale, t } = useT()
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
        {contract ? <ContractDescription contract={contract} /> : null}
      </CardHeader>
      {canManage && contract ? (
        <CardContent>
          <ChangeContract
            contract={contract}
            storageUsedBytes={storageUsedBytes}
            activeProjectCount={activeProjectCount}
          />
        </CardContent>
      ) : null}
      {canManage && contract ? (
        <CardFooter>
          <PortalForm />
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
              id="billing-estimate-overage"
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
  id,
  label,
  note,
  value,
  total = false,
}: {
  id?: string
  label: string
  note: string
  value: string
  total?: boolean
}) {
  return (
    <div
      // These rows form one divided breakdown; only each row's upper border
      // is intentionally flush with the preceding row.
      id={id}
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
    <TeamMutedParagraph data-billing-checkout-pending>
      {t('billing.checkout.pending')}
    </TeamMutedParagraph>
  )
}

function BillingUnavailableNotice() {
  const { t } = useT()

  return (
    <TeamMutedParagraph data-billing-unavailable>
      {t('billing.unavailable')}
    </TeamMutedParagraph>
  )
}

export function shouldShowBillingContext({
  awaitingCheckoutReflection,
  canManage,
  plan,
  entryContext,
}: {
  canManage: boolean
  plan: string
  entryContext: BillingView['entryContext']
  awaitingCheckoutReflection: boolean
}): boolean {
  if (awaitingCheckoutReflection || !canManage || plan === 'team') return false
  return plan !== 'plus' || entryContext !== 'default'
}

export function CheckoutActions({
  isPending = false,
  defaultCurrency,
  initialPlan,
  initialInterval,
  locale,
  externalPostingEnabled,
}: {
  isPending?: boolean
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
            <BillingForm>
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
            </BillingForm>
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
  contract,
}: {
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

      {!contract ? <PortalForm /> : null}
    </>
  )
}

function BillingForm({ children }: { children: ReactNode }) {
  const fetcher = useFetcher<typeof action>()
  useSettingsEntryChange(fetcher.reset)
  return (
    <fetcher.Form
      method="post"
      className="flex flex-col gap-[var(--spacing-2)]"
    >
      <fieldset disabled={fetcher.state !== 'idle'}>{children}</fieldset>
      {fetcher.state === 'idle' && fetcher.data && (
        <StatusBanner status={fetcher.data.code} />
      )}
    </fetcher.Form>
  )
}

function PortalForm() {
  const { t } = useT()
  return (
    <BillingForm>
      <input type="hidden" name="intent" value="portal" />
      <Button variant="outline" size="sm" type="submit">
        {t('billing.portal')}
      </Button>
    </BillingForm>
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
  storageUsedBytes,
  activeProjectCount,
}: {
  contract: SubscriptionContract
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
        />
      </BillingPlanGrid>
    </BillingPlans>
  )
}

function PlanChangeNotice({ kind }: { kind: 'plan' | 'interval' }) {
  const change = useFetcher<typeof action>({ key: `billing-change-${kind}` })
  useSettingsEntryChange(change.reset)
  return change.state === 'idle' && change.data?.ok ? (
    <StatusBanner status={change.data.code} />
  ) : null
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
}: {
  contract: SubscriptionContract
  plan: CheckoutPlan
  interval: BillingInterval
  label: string
  note?: string
  isDowngrade: boolean
  storageUsedBytes: number
  activeProjectCount: number
}) {
  const { locale, t } = useT()
  const [requestedOpen, setOpen] = useState(false)
  useSettingsEntryChange(() => setOpen(false))
  const kind = plan === contract.plan ? 'interval' : 'plan'
  const change = useFetcher<typeof action>({ key: `billing-change-${kind}` })
  const result = change.state === 'idle' ? change.data : undefined
  const open = requestedOpen && !result?.ok
  // Each opening reads its own estimate, so a late answer to a dismissed
  // confirmation (including an expired session) never reaches the next one.
  // It belongs to the history entry it was opened on: a late answer after the
  // user moved to another entry never sends them to sign in from there.
  const previewId = useId()
  const [opening, setOpening] = useState({ count: 0, entry: '' })
  const preview = useFetcher<PlanChangePreview | SessionExpired>({
    key: `${previewId}-${opening.count}`,
  })
  const { load } = preview
  const entry = useLocation().key
  useSignInOnSessionExpired(preview.data, open ? opening.entry : null)
  const newPrice = contractPrice(contract, plan, interval)

  useEffect(() => {
    if (!open) return
    const params = new URLSearchParams({ plan, interval })
    load(`/settings/billing-preview?${params}`)
  }, [open, plan, interval, load])

  const { prorationText, nextInvoiceAtLabel } = planChangePreviewLabels(
    isSessionExpired(preview.data) ? undefined : preview.data,
    preview.state,
    locale,
    t,
  )

  return (
    <>
      <Button
        type="button"
        variant="outline"
        size="sm"
        id={`billing-change-${plan}-${interval}`}
        data-billing-change={plan === contract.plan ? 'interval' : 'plan'}
        className="h-full min-h-7 w-full flex-col py-[var(--spacing-2)] whitespace-normal"
        onClick={() => {
          change.reset()
          setOpening(({ count }) => ({ count: count + 1, entry }))
          setOpen(true)
        }}
      >
        <span className="leading-snug">{label}</span>
        {note ? (
          <span className="text-muted-foreground text-xs leading-tight">
            {note}
          </span>
        ) : null}
      </Button>
      <ConfirmActionDialog
        open={open}
        onOpenChange={setOpen}
        awaitResult
        returnFocusId={`billing-change-${plan}-${interval}`}
        fallbackFocusId="billing-heading"
        title={t('billing.confirm.title')}
        description={t('billing.confirm.body', {
          plan: t(`billing.plan.${plan}`),
          interval: t(`billing.interval.${interval}`),
        })}
        pending={change.state !== 'idle'}
        action={t('billing.confirm.action')}
        onConfirm={() => {
          change.reset()
          void change.submit(
            { intent: 'change-plan', plan, interval },
            { method: 'post' },
          )
        }}
        result={
          <>
            {result && !result.ok && <StatusBanner status={result.code} />}
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
              <TeamMutedParagraph>{prorationText}</TeamMutedParagraph>
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
          </>
        }
      />
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

// A Team workspace without an active subscription gets no purchase controls
// and no presentation of its own.
function billingPresentation(
  data: Pick<BillingView, 'plan' | 'hasSubscription'>,
) {
  if (data.hasSubscription) return 'subscribed'
  return data.plan === 'team' ? 'team-plan' : 'purchase'
}

function BillingActions({
  loaderData,
  awaitingCheckoutReflection,
}: {
  loaderData: BillingView
  awaitingCheckoutReflection: boolean
}) {
  const { locale } = useT()
  if (!loaderData.canManage) return <ReadOnlyNotice />
  if (!loaderData.billingConfigured) return <BillingUnavailableNotice />
  const presentation = billingPresentation(loaderData)
  if (presentation === 'subscribed')
    return <SubscribedActions contract={loaderData.contract} />
  if (presentation === 'team-plan') return null
  if (awaitingCheckoutReflection) return <CheckoutPendingNotice />
  return (
    <CheckoutActions
      defaultCurrency={loaderData.defaultCurrency}
      initialPlan={loaderData.initialPlan}
      initialInterval={loaderData.initialInterval}
      locale={locale}
      externalPostingEnabled={loaderData.externalPostingEnabled}
    />
  )
}

function ContractDescription({ contract }: { contract: SubscriptionContract }) {
  const { t, locale } = useT()
  const hydrated = useHydrated()
  const renewsAtLabel = contractRenewalLabel(
    contract.renewsAt,
    hydrated,
    locale,
  )
  return (
    <CardDescription data-billing-contract-details>
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
      {(contract.currency && contract.amount !== null) || renewsAtLabel ? (
        <br />
      ) : null}
      {t('billing.contract.taxNote')}
    </CardDescription>
  )
}

function planChangePreviewLabels(
  data: PlanChangePreview | undefined,
  state: string,
  locale: string,
  t: ReturnType<typeof useT>['t'],
) {
  const previewLoading = state !== 'idle' || data === undefined
  const proration =
    data?.kind === 'ok' && data.currency && data.prorationAmount !== null
      ? {
          currency: data.currency,
          amount: data.prorationAmount,
        }
      : null
  // 符号は加算・控除の文言で表すため、金額は絶対値で表示する。
  const prorationLabel = proration
    ? formatPrice(proration.currency, Math.abs(proration.amount))
    : null
  // ダイアログは client でしか開かないので、そのままローカル日付で表示できる。
  const nextInvoiceAtLabel =
    data?.kind === 'ok' && data.nextInvoiceAt
      ? new Date(data.nextInvoiceAt).toLocaleDateString(
          locale === 'ja' ? 'ja-JP' : 'en-US',
        )
      : null

  const prorationText = previewLoading
    ? t('billing.confirm.previewLoading')
    : proration && prorationLabel
      ? t(
          proration.amount < 0
            ? 'billing.confirm.prorationCredit'
            : 'billing.confirm.prorationCharge',
          { amount: prorationLabel },
        )
      : t('billing.confirm.previewUnavailable')
  return { prorationText, nextInvoiceAtLabel }
}

function contractRenewalLabel(
  renewsAt: string | null,
  hydrated: boolean,
  locale: string,
) {
  if (!renewsAt) return null
  return hydrated
    ? new Date(renewsAt).toLocaleDateString(locale === 'ja' ? 'ja-JP' : 'en-US')
    : renewsAt.slice(0, 10)
}
