import { CliReferencePage } from '~/components/app/cli-reference-page'
import { cliReferenceMeta } from '~/lib/cli-reference-meta'
import { resolvePublicRouteLocale } from '~/lib/public-route-locale'
import type { Route } from './+types/guides.cli'

export function loader({ params }: Route.LoaderArgs) {
  return { locale: resolvePublicRouteLocale(params.locale) }
}
export function meta({ loaderData }: Route.MetaArgs) {
  return cliReferenceMeta(loaderData?.locale ?? 'en')
}
export default function GuidesCliRoute({ loaderData }: Route.ComponentProps) {
  return <CliReferencePage locale={loaderData.locale} />
}
