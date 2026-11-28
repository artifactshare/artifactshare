import {
  loadUsage,
  sharedOverageProjection,
} from '../+components/billing-usage.server'
import { env } from 'cloudflare:workers'
import { data as actionData, redirect } from 'react-router'
import { settingsFailure } from '~/lib/settings-submission'
import {
  confirmationResult,
  runConfirmedMutation,
} from '~/lib/settings-confirmation'
import type { Route } from './+types/billing'
import { stringValue } from '~/lib/form'
import { getLocale } from '~/lib/i18n.server'
import { requireUser } from '~/middleware/context'
import {
  createCheckoutSession,
  createPortalSession,
  createStripeClient,
  changePlan,
  isBillingConfigured,
  loadSubscriptionContract,
  parseBillingInterval,
  parseCheckoutCurrency,
  parseCheckoutPlan,
  resolveCheckoutCurrency,
  type CheckoutCurrency,
  resolveMonthlyEstimate,
} from '~/services/billing.server'
import {
  allowsStorageOverage,
  isActiveSubscriptionStatus,
} from '~/lib/billing-plan.server'
import { createDb } from '~/services/db.server'
import { requireWorkspaceOwner } from '~/services/team-management.server'
import {
  canUseExternalPosting,
  normalizeWorkspaceLinkPolicy,
} from '~/lib/link-sharing-policy'
import {
  settingsActiveRole,
  settingsWorkspace,
} from '../+lib/settings-request.server'
import { settingsShellShouldRevalidate } from '../+lib/shell-revalidation'
import { checkoutReturnMiddleware } from '../+lib/checkout-return.server'
import { projectLimitForPlan } from '~/lib/billing-plan.server'
import { normalizePlan } from '~/lib/plan-tier'
import { countActiveProjects } from '~/services/projects.server'
import BillingPage, {
  type BillingLoaderData,
} from '../+components/billing-page'

// The page lives in +components so development fixtures can render it without
export default BillingPage
export {
  CheckoutActions,
  DowngradeImpact,
  shouldShowBillingContext,
} from '../+components/billing-page'

export const middleware = [checkoutReturnMiddleware]

export async function loader({
  context,
  request,
}: Route.LoaderArgs): Promise<BillingLoaderData> {
  const user = requireUser(context)
  const db = createDb()

  const [workspace, role] = await Promise.all([
    settingsWorkspace(context),
    settingsActiveRole(context),
  ])

  const hasSubscription = Boolean(
    workspace.stripe_subscription_id &&
    isActiveSubscriptionStatus(workspace.stripe_subscription_status),
  )
  const billingConfigured = isBillingConfigured(env)
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

  const estimateNow = new Date()
  const readProjection = sharedOverageProjection(user.workspaceId, estimateNow)
  const projection = canManage && contract ? await readProjection() : null
  const monthlyEstimate = resolveMonthlyEstimate(
    contract,
    projection,
    estimateNow,
    allowsStorageOverage(workspace.plan, workspace.stripe_subscription_status),
    workspace.stripe_subscription_status,
  )

  const query = new URL(request.url).searchParams
  const initialPlan = parseCheckoutPlan(query.get('plan')) ?? 'team'
  const initialInterval =
    parseBillingInterval(query.get('interval')) ?? 'monthly'
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
  const authorized = await requireWorkspaceOwner(db, user)
  if (authorized.kind !== 'ok') return settingsFailure(intent, authorized.kind)
  if (!['change-plan', 'checkout', 'portal'].includes(intent))
    return settingsFailure(intent, 'invalid')
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
    if (result.kind === 'ok' || result.kind === 'portal')
      return redirect(result.url)
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
    if (result.kind === 'portal') return redirect(result.url)
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
