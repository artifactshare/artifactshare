import { PricingPage } from '~/components/app/pricing-page'
import { type Locale } from '~/i18n/messages'
import { APEX_HOST } from '~/lib/hosts'
import { socialMeta } from '~/lib/social-meta'
import { userContext } from '~/middleware/context'
import { defaultBillingCurrency } from '~/lib/billing-prices'
import { PRICING_COPY } from '~/lib/pricing-content'
import { resolvePublicRouteLocale } from '~/lib/public-route-locale'
export { pricingCheckoutHref } from '~/lib/pricing-checkout'
import type { Route } from './+types/pricing'
import type { ScreenSpec } from '~/types/screen'

export const screen = {
  id: 'pricing',
  route: {
    en: '/pricing',
    ja: '/ja/pricing',
  },
  auth: 'anonymous',
  loop: 'support',
  metric: '適切なプラン選択を増やす',
  role: '料金とプランの違いを比較できる',
  primaryAction: 'プランを選ぶ',
  states: [
    {
      id: 'default',
      description: '通常の Pricing',
      setup: {},
    },
  ],
} satisfies ScreenSpec

export function loader({ params, request, context }: Route.LoaderArgs) {
  return {
    locale: resolvePublicRouteLocale(params.locale),
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
  const canonical = `https://${APEX_HOST}${
    loaderData?.locale === 'ja' ? '/ja' : ''
  }/pricing`
  const enCanonical = `https://${APEX_HOST}/pricing`
  const jaCanonical = `https://${APEX_HOST}/ja/pricing`
  return [
    { title: c.title },
    { name: 'description', content: c.description },
    { tagName: 'link', rel: 'canonical', href: canonical },
    { tagName: 'link', rel: 'alternate', hrefLang: 'en', href: enCanonical },
    {
      tagName: 'link',
      rel: 'alternate',
      hrefLang: 'ja',
      href: jaCanonical,
    },
    {
      tagName: 'link',
      rel: 'alternate',
      hrefLang: 'x-default',
      href: enCanonical,
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
