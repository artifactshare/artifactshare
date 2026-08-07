import type { ReactNode } from 'react'
import { Button } from '~/components/ui/button'
import { SegmentedControlGroup } from '~/components/ui/segmented-control'
import type { BillingCurrency, PriceInterval } from '~/lib/billing-prices'
import type { PricingCopy } from '~/lib/pricing-content'

const groupClassName =
  'border-border bg-muted m-0 flex rounded-[var(--r-md)] border p-1 max-sm:w-full'
const buttonClassName =
  'aria-pressed:bg-background aria-pressed:text-foreground text-muted-foreground flex-1 aria-pressed:shadow-sm'

export function BillingSelection({
  copy,
  currency,
  interval,
  onCurrencyChange,
  onIntervalChange,
}: {
  copy: Pick<
    PricingCopy,
    'billingInterval' | 'monthly' | 'yearly' | 'save' | 'currency'
  >
  currency: BillingCurrency
  interval: PriceInterval
  onCurrencyChange: (currency: BillingCurrency) => void
  onIntervalChange: (interval: PriceInterval) => void
}) {
  const intervalOptions: Array<{ value: PriceInterval; label: ReactNode }> = [
    { value: 'month', label: copy.monthly },
    {
      value: 'year',
      label: (
        <>
          {copy.yearly}{' '}
          <span className="text-link ml-1 text-xs">{copy.save}</span>
        </>
      ),
    },
  ]

  return (
    <>
      <fieldset className={groupClassName}>
        <legend className="sr-only">{copy.billingInterval}</legend>
        <SegmentedControlGroup className="flex max-sm:w-full">
          {intervalOptions.map((option) => (
            <Button
              key={option.value}
              variant="ghost"
              aria-pressed={interval === option.value}
              className={buttonClassName}
              onClick={() => onIntervalChange(option.value)}
            >
              {option.label}
            </Button>
          ))}
        </SegmentedControlGroup>
      </fieldset>
      <fieldset className={groupClassName}>
        <legend className="sr-only">{copy.currency}</legend>
        <SegmentedControlGroup className="flex max-sm:w-full">
          {(['jpy', 'usd'] as const).map((value) => (
            <Button
              key={value}
              variant="ghost"
              aria-pressed={currency === value}
              className={buttonClassName}
              onClick={() => onCurrencyChange(value)}
            >
              {value.toUpperCase()}
            </Button>
          ))}
        </SegmentedControlGroup>
      </fieldset>
    </>
  )
}
