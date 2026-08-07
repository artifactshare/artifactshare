import { CliReferencePage } from '~/components/app/cli-reference-page'
import { DEFAULT_LOCALE } from '~/i18n/messages'
import { cliReferenceMeta } from '~/lib/cli-reference-meta'
import type { Route } from './+types/guides.cli'

export function loader() {
  return { locale: DEFAULT_LOCALE }
}
export function meta({ loaderData }: Route.MetaArgs) {
  return cliReferenceMeta(loaderData?.locale ?? DEFAULT_LOCALE)
}
export default function GuidesCliRoute({ loaderData }: Route.ComponentProps) {
  return <CliReferencePage locale={loaderData.locale} />
}
