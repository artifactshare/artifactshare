import { CliReferencePage } from '~/components/app/cli-reference-page'
import { cliReferenceMeta } from '~/lib/cli-reference-meta'
import type { Route } from './+types/ja.guides.cli'

export function loader() {
  return { locale: 'ja' as const }
}
export function meta({ loaderData }: Route.MetaArgs) {
  return cliReferenceMeta(loaderData?.locale ?? 'ja')
}
export default function JaGuidesCliRoute({ loaderData }: Route.ComponentProps) {
  return <CliReferencePage locale={loaderData.locale} />
}
