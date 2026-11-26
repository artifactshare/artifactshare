import { env } from 'cloudflare:workers'
import type { MiddlewareFunction } from 'react-router'
import { requireUser } from '~/middleware/context'
import { syncReturnedCheckout } from '~/services/billing-sync.server'
import {
  createStripeClient,
  isBillingConfigured,
} from '~/services/billing.server'
import { createDb } from '~/services/db.server'
import { settingsActiveRole } from './settings-request.server'

/**
 * On the owner's return from Stripe Checkout, syncs the subscription that
 * Checkout created before any Settings loader reads the workspace, so the
 * billing page shows the plan just bought. It runs as middleware because the
 * Settings shell loader, which reads the plan, runs alongside the billing
 * loader. If the sync fails, the page shows the same pending notice as before
 * and the webhook brings the plan later.
 */
export const checkoutReturnMiddleware: MiddlewareFunction<Response> = async (
  { url, request, context },
  next,
) => {
  const checkoutSessionId = url.searchParams.get('session_id')
  if (
    request.method === 'GET' &&
    url.searchParams.get('status') === 'checkout-success' &&
    checkoutSessionId &&
    isBillingConfigured(env) &&
    (await settingsActiveRole(context)) === 'owner'
  ) {
    const user = requireUser(context)
    try {
      const result = await syncReturnedCheckout(
        createDb(),
        createStripeClient(env),
        env,
        user.workspaceId,
        checkoutSessionId,
      )
      if (result.kind !== 'ok')
        console.warn('billing_checkout_return_not_synced', {
          workspaceId: user.workspaceId,
          result: result.kind,
        })
    } catch (error) {
      console.error('billing_checkout_return_sync_failed', {
        workspaceId: user.workspaceId,
        error,
      })
    }
  }
  return next()
}
