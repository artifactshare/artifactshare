export type BillingCurrency = 'jpy' | 'usd'
export type PriceInterval = 'month' | 'year'
export type BillingPlan = 'free' | 'plus' | 'team'

export const PLAN_STORAGE_QUOTA_BYTES = {
  free: 100 * 1024 * 1024,
  plus: 10 * 1024 * 1024 * 1024,
  team: 100 * 1024 * 1024 * 1024,
} as const satisfies Record<BillingPlan, number>

export const PLAN_PROJECT_LIMITS = {
  free: 5,
  plus: 20,
  team: null,
} as const satisfies Record<BillingPlan, number | null>

export const BILLING_PRICES = {
  free: {
    jpy: { month: 0, year: 0 },
    usd: { month: 0, year: 0 },
  },
  plus: {
    jpy: { month: 800, year: 8000 },
    usd: { month: 5, year: 50 },
  },
  team: {
    jpy: { month: 4500, year: 45000 },
    usd: { month: 29, year: 290 },
  },
} as const satisfies Record<
  BillingPlan,
  {
    jpy: Record<PriceInterval, number>
    usd: Record<PriceInterval, number>
  }
>

export const PLAN_DISPLAY = {
  free: { storage: '100 MB', projects: '5' },
  plus: { storage: '10 GB', projects: '20' },
  team: { storage: '100 GB', projects: 'Unlimited' },
} as const satisfies Record<BillingPlan, { storage: string; projects: string }>

export const STORAGE_OVERAGE_PRICES = {
  jpy: 16,
  usd: 0.1,
} as const satisfies Record<BillingCurrency, number>

export function defaultBillingCurrency(country: unknown): BillingCurrency {
  return country === 'JP' ? 'jpy' : 'usd'
}

export function formatPrice(currency: BillingCurrency, amount: number): string {
  return currency === 'jpy'
    ? `¥${amount.toLocaleString('ja-JP')}`
    : `$${amount}`
}
