import type {
  BillingSubscription,
  BillingStripeClient,
} from '~/services/billing-sync.server'
export function stripeSubscription(
  overrides: Partial<BillingSubscription> = {},
): BillingSubscription {
  return {
    id: 'sub_test',
    status: 'active',
    metadata: {},
    customer: 'cus_test',
    items: { data: [] },
    ...overrides,
  }
}
export function stripeClient(
  overrides: Partial<BillingStripeClient> = {},
): BillingStripeClient {
  return {
    subscriptions: { retrieve: () => Promise.resolve(stripeSubscription()) },
    ...overrides,
  }
}
