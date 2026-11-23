// Types for `capture-stripe.mjs`, read by the web app's tests.

export const CAPTURE_STRIPE_SECRET_KEY: string
export const CAPTURE_STRIPE_PRICES: {
  plusMonthly: string
  plusYearly: string
  teamMonthly: string
  teamYearly: string
}
export function captureStripePeriod(now?: Date): {
  start: number
  end: number
}

export function captureStripeVars(origin: string): {
  STRIPE_SECRET_KEY: string
  STRIPE_PRICE_PLUS_MONTHLY: string
  STRIPE_PRICE_PLUS_YEARLY: string
  STRIPE_PRICE_TEAM_MONTHLY: string
  STRIPE_PRICE_TEAM_YEARLY: string
  STRIPE_PRODUCT_STORAGE_OVERAGE: string
  STRIPE_PORTAL_CONFIGURATION: string
  STRIPE_WEBHOOK_SECRET: string
  STRIPE_API_ORIGIN: string
}

export function captureStripeResponse(
  request: {
    method: string | undefined
    path: string
    authorization: string | null | undefined
    body: string
  },
  period?: { start: number; end: number },
): { status: number; body: unknown }

export function startCaptureStripe(options?: {
  host?: string
  clock?: () => Date
}): Promise<{
  origin: string
  close: () => Promise<void>
}>
