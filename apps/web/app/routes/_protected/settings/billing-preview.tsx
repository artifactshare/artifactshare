import { env } from 'cloudflare:workers'
import type { Route } from './+types/billing-preview'
import { requireUser } from '~/middleware/context'
import { createDb } from '~/services/db.server'
import {
  createStripeClient,
  isBillingConfigured,
  previewPlanChange,
  type PlanChangePreview,
} from '~/services/billing.server'
import { requireWorkspaceBillingOwner } from '~/services/team-management.server'

export async function loader({
  request,
  context,
}: Route.LoaderArgs): Promise<PlanChangePreview> {
  const user = requireUser(context)
  if (!isBillingConfigured(env) || !env.STRIPE_SECRET_KEY) {
    return { kind: 'external-failed' }
  }

  const query = new URL(request.url).searchParams
  const plan = query.get('plan')
  const interval = query.get('interval')
  if (
    (plan !== 'plus' && plan !== 'team') ||
    (interval !== 'monthly' && interval !== 'yearly')
  ) {
    return { kind: 'invalid' }
  }

  const db = createDb()
  const [authorized, workspace] = await Promise.all([
    requireWorkspaceBillingOwner(db, user),
    db
      .selectFrom('workspaces')
      .select([
        'id',
        'plan',
        'stripe_customer_id',
        'stripe_subscription_id',
        'stripe_subscription_status',
      ])
      .where('id', '=', user.workspaceId)
      .executeTakeFirstOrThrow(),
  ])
  // fetcher 呼び出しのため throw せず、UI が「見込み額を取得できない」扱いに落ちる値を返す。
  if (authorized.kind !== 'ok') {
    return { kind: 'external-failed' }
  }

  return await previewPlanChange(
    createStripeClient(env),
    env,
    workspace,
    plan,
    interval,
  )
}
