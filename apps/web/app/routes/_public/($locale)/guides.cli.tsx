import { CliReferencePage } from '~/components/app/cli-reference-page'
import { cliReferenceMeta } from '~/lib/cli-reference-meta'
import { resolvePublicRouteLocale } from '~/lib/public-route-locale'
import type { ScreenSpec } from '~/types/screen'
import type { Route } from './+types/guides.cli'

export const screen = {
  id: 'guides-cli',
  route: {
    en: '/guides/cli',
    ja: '/ja/guides/cli',
  },
  auth: 'anonymous',
  loop: 'create',
  metric: 'CLI利用による作成を増やす',
  role: 'CLIの使い方を案内する',
  primaryAction: 'ガイドを読む',
  states: [
    {
      id: 'default',
      description: 'CLIガイド',
      setup: {},
    },
  ],
} satisfies ScreenSpec

export function loader({ params }: Route.LoaderArgs) {
  return { locale: resolvePublicRouteLocale(params.locale) }
}
export function meta({ loaderData }: Route.MetaArgs) {
  return cliReferenceMeta(loaderData?.locale ?? 'en')
}
export default function GuidesCliRoute({ loaderData }: Route.ComponentProps) {
  return <CliReferencePage locale={loaderData.locale} />
}
