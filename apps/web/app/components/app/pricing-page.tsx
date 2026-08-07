import { useState } from 'react'
import { Link } from 'react-router'
import { BillingSelection } from '~/components/app/billing-toggle'
import { GuideHomeLink, GuideTopbar } from '~/components/app/guide-shell'
import { PlanCard } from '~/components/app/plan-card'
import { PublicFooter } from '~/components/app/public-footer'
import { Button } from '~/components/ui/button'
import type { Locale } from '~/i18n/messages'
import {
  type BillingCurrency,
  type BillingPlan,
  type PriceInterval,
} from '~/lib/billing-prices'
import { pricingCheckoutHref } from '~/lib/pricing-checkout'
import {
  comparisonValuesForCurrency,
  PRICING_COPY,
} from '~/lib/pricing-content'

export function PricingPage({
  locale,
  initialCurrency,
  signedIn,
  regressionRegions,
  regressionPrimary,
}: {
  locale: Locale
  initialCurrency: BillingCurrency
  signedIn: boolean
  regressionRegions?: {
    header?: string
    main?: string
    footer?: string
  }
  regressionPrimary?: string
}) {
  const c = PRICING_COPY[locale]
  const [currency, setCurrency] = useState(initialCurrency)
  const [interval, setBillingInterval] = useState<PriceInterval>('month')
  const checkoutHref = (plan: BillingPlan) =>
    pricingCheckoutHref(plan, interval, currency, signedIn, locale)
  return (
    <>
      <GuideTopbar data-regression-region={regressionRegions?.header}>
        <GuideHomeLink homeLabel={c.homeLabel} />
      </GuideTopbar>
      <main
        data-regression-region={regressionRegions?.main}
        className="text-foreground mx-auto max-w-6xl px-6 pt-18 pb-24 max-sm:px-4 max-sm:pt-10"
      >
        <section className="mx-auto max-w-3xl text-center">
          <p className="text-muted-foreground m-0 text-sm font-semibold">
            {c.eyebrow}
          </p>
          <h1 className="mt-3 mb-0 text-4xl leading-tight font-bold tracking-tight max-sm:text-3xl">
            {c.hero}
          </h1>
          <p className="text-muted-foreground mx-auto mt-5 mb-0 max-w-2xl text-lg leading-relaxed max-sm:text-base">
            {c.body}
          </p>
          <div className="mt-8 flex flex-wrap justify-center gap-3 max-sm:flex-col">
            <BillingSelection
              copy={c}
              currency={currency}
              interval={interval}
              onCurrencyChange={setCurrency}
              onIntervalChange={setBillingInterval}
            />
          </div>
        </section>
        <section
          className="mt-11 grid items-stretch gap-4 md:grid-cols-3"
          aria-label={c.eyebrow}
        >
          {(['free', 'plus', 'team'] as const).map((plan) => (
            <PlanCard
              key={plan}
              plan={plan}
              currency={currency}
              interval={interval}
              copy={c}
            >
              <Button
                asChild
                variant={plan === 'team' ? 'default' : 'outline'}
                className="w-full"
                data-regression-primary={
                  plan === 'team' ? regressionPrimary : undefined
                }
              >
                <Link to={checkoutHref(plan)}>{c.choose[plan]}</Link>
              </Button>
            </PlanCard>
          ))}
        </section>
        <section className="mt-16 grid gap-10 lg:grid-cols-2">
          <div>
            <h2 className="m-0 mb-4 text-2xl font-semibold">{c.compare}</h2>
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-left text-sm">
                <thead>
                  <tr>
                    <th
                      className="border-border border-b px-2 py-3"
                      scope="col"
                    >
                      {c.comparisonFeature}
                    </th>
                    {['Free', 'Plus', 'Team'].map((plan) => (
                      <th
                        key={plan}
                        className="border-border border-b px-2 py-3 text-center"
                        scope="col"
                      >
                        {plan}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {c.comparison.map((row, rowIndex) => (
                    <tr key={`comparison-row-${rowIndex}`}>
                      <th
                        className="border-border border-b px-2 py-3 font-medium"
                        scope="row"
                      >
                        {row.label}
                      </th>
                      {comparisonValuesForCurrency(row.values, currency).map(
                        (value, planIndex) => {
                          const plan = (['free', 'plus', 'team'] as const)[
                            planIndex
                          ]
                          return (
                            <td
                              className="border-border border-b px-2 py-3 text-center"
                              key={`comparison-${rowIndex}-${plan}`}
                            >
                              {value}
                            </td>
                          )
                        },
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
          <div>
            <h2 className="m-0 mb-4 text-2xl font-semibold">{c.faq}</h2>
            <div className="border-border border-t">
              {c.faqs.map((faq, faqIndex) => (
                <div
                  className="border-border border-b py-4"
                  key={`faq-${faqIndex}`}
                >
                  <h3 className="m-0 text-sm font-semibold">{faq.question}</h3>
                  <p className="text-muted-foreground mt-1 mb-0 text-sm leading-relaxed">
                    {faq.answer}
                  </p>
                </div>
              ))}
            </div>
          </div>
        </section>
      </main>
      <PublicFooter data-regression-region={regressionRegions?.footer} />
    </>
  )
}
