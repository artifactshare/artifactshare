import { PricingPage } from '~/components/app/pricing-page'
import { DEFAULT_LOCALE, type Locale } from '~/i18n/messages'
import { APEX_HOST } from '~/lib/hosts'
import { socialMeta } from '~/lib/social-meta'
import { userContext } from '~/middleware/context'
import { defaultBillingCurrency } from '~/lib/billing-prices'
import { PRICING_COPY } from '~/lib/pricing-content'
export { pricingCheckoutHref } from '~/lib/pricing-checkout'
import type { Route } from './+types/pricing'

export function loader({ request, context }: Route.LoaderArgs) {
  return {
    locale: DEFAULT_LOCALE,
    currency: defaultBillingCurrency(request.cf?.country),
    signedIn: Boolean(context.get(userContext)),
  }
}
export { PricingPage }
export function pricingLocaleHref(locale: Locale): string {
  return locale === 'ja' ? '/ja/pricing' : '/pricing'
}
export function meta({ loaderData }: Route.MetaArgs) {
  const c = PRICING_COPY[loaderData?.locale ?? 'en']
  const canonical = `https://${APEX_HOST}/pricing`
  return [
    { title: c.title },
    { name: 'description', content: c.description },
    { tagName: 'link', rel: 'canonical', href: canonical },
    { tagName: 'link', rel: 'alternate', hrefLang: 'en', href: canonical },
    {
      tagName: 'link',
      rel: 'alternate',
      hrefLang: 'ja',
      href: `https://${APEX_HOST}/ja/pricing`,
    },
    {
      tagName: 'link',
      rel: 'alternate',
      hrefLang: 'x-default',
      href: canonical,
    },
    ...socialMeta({
      title: c.title,
      description: c.description,
      url: canonical,
      image: `https://${APEX_HOST}/og-image`,
    }),
  ]
}

export default function PricingRoute({ loaderData }: Route.ComponentProps) {
  return (
    <PricingPage
      locale={loaderData.locale}
      initialCurrency={loaderData.currency}
      signedIn={loaderData.signedIn}
    />
  )
}
