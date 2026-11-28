// View for the pstack /statechart skill: labels BillingSync states and steps
// in the words of a workspace owner who buys a plan.
const values = (x) => (Array.isArray(x) ? x : Object.values(x ?? {}))

export const title = 'Buying a plan and keeping it in sync with Stripe'

export const state = (v) => {
  const billable = values(v.subs).filter((s) => s.ex && (s.status === 'active' || s.status === 'past_due'))
  const open = values(v.sessions).filter((s) => s === 'open').length
  const stripe =
    billable.length === 0
      ? open > 0
        ? `No subscription, ${open} Checkout page${open > 1 ? 's' : ''} open`
        : 'No subscription'
      : billable.length === 1
        ? `Billing ${billable[0].plan}, ${billable[0].status.replace('_', ' ')}`
        : 'Billing two subscriptions'
  const shown = v.ws.subId === 0 ? v.ws.plan : `${v.ws.plan}, ${v.ws.status.replace('_', ' ')}`
  return { Stripe: stripe, 'Artifact Share': `Shows ${shown}` }
}

export const group = (v) => (values(v.pending).length > 0 ? 'events pending' : 'quiet')

export const colors = { 'events pending': 'yellow', quiet: 'blue' }

const LABELS = {
  TabReadWorkspace: 'you press Upgrade',
  TabListOpen: 'we look for open Checkout pages',
  TabExpire: 'we close them',
  TabListSubscriptions: 'we look for a subscription',
  TabEnsureCustomer: 'we make sure there is a Stripe customer',
  TabCreateSession: 'a Checkout page opens',
  StripeCompleteCheckout: 'you pay on a Checkout page',
  StripeChange: 'Stripe changes the subscription',
  SyncRetrieve: 'a webhook reads the subscription',
  SyncReadWorkspace: 'the webhook reads the workspace',
  SyncWrite: 'the webhook saves the plan',
}

export const step = (action) => LABELS[action] ?? null
