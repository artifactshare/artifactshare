import { PricingPage } from '~/components/app/pricing-page'

export function PublicPricingFixture() {
  return (
    <PricingPage
      locale="en"
      initialCurrency="usd"
      signedIn={false}
      regressionRegions={{
        header: 'header',
        main: 'main',
        footer: 'footer',
      }}
      regressionPrimary="choose-plan"
    />
  )
}
