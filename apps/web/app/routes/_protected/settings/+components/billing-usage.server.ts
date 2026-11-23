import { logErrorDiagnostic } from '~/lib/error-diagnostics.server'
import { env } from 'cloudflare:workers'
import { type BillingCurrency } from '~/lib/billing-prices'
import {
  allowsStorageOverage,
  storageQuotaForPlan,
} from '~/lib/billing-plan.server'
import {
  loadCurrentMonthOverageProjection,
  type OverageProjection,
} from '~/services/billing-usage.server'
import {
  createStripeClient,
  isBillingConfigured,
  loadSubscriptionContract,
  type SubscriptionContract,
} from '~/services/billing.server'
import { countWorkspaceContributors } from '~/services/team-management.server'
import { createDb } from '~/services/db.server'
import type { SettingsWorkspaceSnapshot } from '../+lib/settings-request.server'

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

/**
 * This month's overage projection, computed at most once however many billing
 * views ask for it. A failed projection reads as none.
 */
export function sharedOverageProjection(
  workspaceId: string,
  now: Date,
): () => Promise<OverageProjection | null> {
  let projection: Promise<OverageProjection | null> | undefined
  return () => {
    projection ??= loadCurrentMonthOverageProjection(
      createDb(),
      workspaceId,
      now,
    ).catch((error) => {
      logErrorDiagnostic('billing.projection', error)
      return null
    })
    return projection
  }
}

export async function loadUsage({
  workspace,
  projection: readProjection,
  contract: knownContract,
}: {
  workspace: Pick<
    SettingsWorkspaceSnapshot,
    'id' | 'plan' | 'stripe_subscription_status' | 'stripe_subscription_id'
  >
  projection: () => Promise<OverageProjection | null>
  contract?: SubscriptionContract | null
}): Promise<UsageLoaderData> {
  const showOverageProjection = allowsStorageOverage(
    workspace.plan,
    workspace.stripe_subscription_status,
  )
  const includedBytes = storageQuotaForPlan(workspace.plan)

  const contributorCount =
    workspace.plan === 'team'
      ? await countWorkspaceContributors(createDb(), workspace.id)
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
    readProjection(),
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
