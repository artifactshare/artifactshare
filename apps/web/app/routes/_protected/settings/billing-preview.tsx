import { env } from 'cloudflare:workers'
import type { Route } from './+types/billing-preview'
import { isInterruptedRequest } from '~/lib/settings-confirmation'
import {
  readConfirmationResource,
  type SessionExpired,
} from '~/lib/session-expired'
import { requireUserApiMiddleware } from '~/middleware/auth'
import { requireUser } from '~/middleware/context'
import { createDb } from '~/services/db.server'
import {
  createStripeClient,
  isBillingConfigured,
  parseBillingInterval,
  parseCheckoutPlan,
  previewPlanChange,
  type PlanChangePreview,
} from '~/services/billing.server'
import { requireWorkspaceOwner } from '~/services/team-management.server'

export const middleware = [requireUserApiMiddleware]

export async function loader({
  request,
  context,
}: Route.LoaderArgs): Promise<PlanChangePreview> {
  const user = requireUser(context)
  if (!isBillingConfigured(env) || !env.STRIPE_SECRET_KEY) {
    return { kind: 'external-failed' }
  }

  const query = new URL(request.url).searchParams
  const plan = parseCheckoutPlan(query.get('plan'))
  const interval = parseBillingInterval(query.get('interval'))
  if (!plan || !interval) return { kind: 'invalid' }

  const db = createDb()
  const [authorized, workspace] = await Promise.all([
    requireWorkspaceOwner(db, user),
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

export async function loadEstimate(
  serverLoader: () => Promise<PlanChangePreview>,
): Promise<PlanChangePreview | SessionExpired> {
  try {
    return await readConfirmationResource(serverLoader)
  } catch (error) {
    if (isInterruptedRequest(error)) return { kind: 'external-failed' }
    throw error
  }
}

export function clientLoader({ serverLoader }: Route.ClientLoaderArgs) {
  return loadEstimate(serverLoader)
}
