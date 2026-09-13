import { CliReferencePage } from '~/components/app/cli-reference-page'
import { DEFAULT_LOCALE } from '~/i18n/messages'
import { cliReferenceMeta } from '~/lib/cli-reference-meta'
import type { Route } from './+types/guides.cli'
import type { ScreenSpec } from '~/types/screen'

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

export function loader() {
  return { locale: DEFAULT_LOCALE }
}
export function meta({ loaderData }: Route.MetaArgs) {
  return cliReferenceMeta(loaderData?.locale ?? DEFAULT_LOCALE)
}
export default function GuidesCliRoute({ loaderData }: Route.ComponentProps) {
  return <CliReferencePage locale={loaderData.locale} />
}
