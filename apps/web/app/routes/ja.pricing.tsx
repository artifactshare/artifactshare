import { PricingPage } from './pricing'
import type { Route } from './+types/ja.pricing'
import { PRICING_COPY } from '~/lib/pricing-content'
import { APEX_HOST } from '~/lib/hosts'
import { socialMeta } from '~/lib/social-meta'
import { userContext } from '~/middleware/context'
import { defaultBillingCurrency } from '~/lib/billing-prices'
export function loader({ request, context }: Route.LoaderArgs) {
  return {
    locale: 'ja' as const,
    currency: defaultBillingCurrency(request.cf?.country),
    signedIn: Boolean(context.get(userContext)),
  }
}
export function meta() {
  const copy = PRICING_COPY.ja
  const canonical = `https://${APEX_HOST}/ja/pricing`
  return [
    { title: copy.title },
    { name: 'description', content: copy.description },
    {
      tagName: 'link',
      rel: 'canonical',
      href: canonical,
    },
    {
      tagName: 'link',
      rel: 'alternate',
      hrefLang: 'en',
      href: `https://${APEX_HOST}/pricing`,
    },
    {
      tagName: 'link',
      rel: 'alternate',
      hrefLang: 'ja',
      href: canonical,
    },
    {
      tagName: 'link',
      rel: 'alternate',
      hrefLang: 'x-default',
      href: `https://${APEX_HOST}/pricing`,
    },
    ...socialMeta({
      title: copy.title,
      description: copy.description,
      url: canonical,
      image: `https://${APEX_HOST}/og-image`,
    }),
  ]
}
export default function JaPricingRoute({ loaderData }: Route.ComponentProps) {
  return (
    <PricingPage
      locale={loaderData.locale}
      initialCurrency={loaderData.currency}
      signedIn={loaderData.signedIn}
    />
  )
}
