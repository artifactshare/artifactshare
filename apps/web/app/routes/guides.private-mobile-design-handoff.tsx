import { PrivateMobileDesignHandoffPage } from '~/components/app/private-mobile-design-handoff-page'
import { privateMobileDesignHandoffMeta } from '~/lib/private-mobile-design-handoff-meta'
import { getPrivateMobileDesignHandoffContent } from '~/services/private-mobile-design-handoff-content.server'
import type { Route } from './+types/guides.private-mobile-design-handoff'

export function loader() {
  return getPrivateMobileDesignHandoffContent('en')
}
export function meta({ loaderData }: Route.MetaArgs) {
  return privateMobileDesignHandoffMeta(loaderData?.locale ?? 'en')
}
export default function GuidesPrivateMobileDesignHandoffRoute({
  loaderData,
}: Route.ComponentProps) {
  return <PrivateMobileDesignHandoffPage {...loaderData} />
}
