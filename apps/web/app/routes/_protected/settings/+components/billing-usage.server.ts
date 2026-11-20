import { env } from 'cloudflare:workers'
import { type BillingCurrency } from '~/lib/billing-prices'
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
  type SubscriptionContract,
} from '~/services/billing.server'
import { countWorkspaceContributors } from '~/services/team-management.server'
import { createDb } from '~/services/db.server'

export type OverageProjectionView = {
  gb: number
  currency: BillingCurrency | null
  amount: number | null
}

export type UsageLoaderData = {
  showOverageProjection: boolean
  includedBytes: number
  overageProjection: OverageProjectionView | null
  contributorCount: number | null
}

export async function loadUsage({
  context,
  contract: knownContract,
}: {
  context: Readonly<import('react-router').RouterContextProvider>
  contract?: SubscriptionContract | null
}): Promise<UsageLoaderData> {
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
    loadCurrentMonthOverageProjection(db, workspace.id, new Date()).catch(
      () => null,
    ),
    knownContract !== undefined
      ? Promise.resolve(knownContract)
      : workspace.stripe_subscription_id && isBillingConfigured(env)
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
    overageProjection: projection
      ? {
          gb: projection.projectedOverageGb,
          currency,
          amount:
            currency === 'jpy'
              ? Math.round(projection.projectedOverageJpy)
              : currency === 'usd'
                ? Math.round(projection.projectedOverageUsd * 100) / 100
                : null,
        }
      : null,
    contributorCount,
  }
}
