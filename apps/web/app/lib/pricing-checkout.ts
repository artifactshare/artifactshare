import type {
  BillingCurrency,
  BillingPlan,
  PriceInterval,
} from '~/lib/billing-prices'
import type { Locale } from '~/i18n/messages'

export function pricingCheckoutHref(
  plan: BillingPlan,
  interval: PriceInterval,
  currency: BillingCurrency,
  signedIn: boolean,
  locale: Locale,
): string {
  if (plan === 'free') {
    const startPath = locale === 'ja' ? '/ja/start' : '/start'
    return signedIn ? startPath : `/sign-in?next=${startPath}`
  }
  const q = new URLSearchParams({
    plan,
    interval: interval === 'month' ? 'monthly' : 'yearly',
    currency,
  })
  return `/settings/billing?${q}`
}
