import type { ReactNode } from 'react'
import { Badge } from '~/components/ui/badge'
import {
  BILLING_PRICES,
  formatPrice,
  type BillingCurrency,
  type BillingPlan,
  type PriceInterval,
} from '~/lib/billing-prices'
import { yearlyEquivalent, type PricingCopy } from '~/lib/pricing-content'

export function PlanCard({
  plan,
  currency,
  interval,
  copy,
  children,
  headingLevel = 'h2',
}: {
  plan: BillingPlan
  currency: BillingCurrency
  interval: PriceInterval
  copy: PricingCopy
  children: ReactNode
  headingLevel?: 'h2' | 'h4'
}) {
  const price = BILLING_PRICES[plan][currency][interval]
  const Heading = headingLevel
  return (
    <article
      data-plan={plan}
      className={`border-border bg-card relative flex min-w-0 flex-col rounded-[var(--r-lg)] border p-6 shadow-sm ${plan === 'team' ? 'border-link ring-link/90 shadow-link/10 ring-1' : ''}`}
    >
      {plan === 'team' ? (
        <Badge className="absolute top-0 right-5 -translate-y-1/2">
          {copy.recommended}
        </Badge>
      ) : null}
      <div className="flex items-center justify-between">
        <Heading
          className={`m-0 font-semibold ${headingLevel === 'h4' ? 'text-sm' : 'text-xl'}`}
        >
          {plan[0].toUpperCase() + plan.slice(1)}
        </Heading>
      </div>
      <p className="text-muted-foreground mt-2 mb-5 min-h-11 text-sm">
        {copy.plans[plan].description}
      </p>
      <div className="min-h-24">
        <p className="m-0 text-3xl font-bold tracking-tight">
          {formatPrice(currency, price)}{' '}
          <span className="text-muted-foreground text-sm">
            / {copy.period[interval]}
          </span>
        </p>
        {plan !== 'free' ? (
          <p className="text-muted-foreground mt-1 text-sm">
            {interval === 'year' ? (
              <>
                {yearlyEquivalent(currency, plan)} / {copy.period.month} ·{' '}
                {copy.billedYearly}
              </>
            ) : (
              copy.billedMonthly
            )}
          </p>
        ) : null}
        {copy.plans[plan].priceNote ? (
          <p className="text-muted-foreground mt-1 text-sm">
            {copy.plans[plan].priceNote}
          </p>
        ) : null}
      </div>
      {currency === 'jpy' && interval === 'year' && plan === 'team' ? (
        <p className="text-muted-foreground text-sm">
          {copy.plans[plan].yearlyTaxNote}
        </p>
      ) : null}
      <div className="mt-4">{children}</div>
      <ul className="mt-5 list-none p-0 text-sm">
        {copy.plans[plan].features.map((feature) => (
          <li
            className="border-muted before:text-link relative border-t py-2 pl-6 before:absolute before:left-0 before:content-['✓']"
            key={`${plan}-${feature}`}
          >
            {feature}
          </li>
        ))}
      </ul>
      <p className="text-muted-foreground mt-auto pt-4 text-xs leading-relaxed">
        {copy.plans[plan].note}
      </p>
    </article>
  )
}
