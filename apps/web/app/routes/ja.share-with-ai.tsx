import { ShareWithAiPage, shareWithAiMeta } from './share-with-ai'
import type { Route } from './+types/ja.share-with-ai'

export function loader() {
  return { locale: 'ja' as const }
}

export function meta({ loaderData }: Route.MetaArgs) {
  return shareWithAiMeta(loaderData?.locale ?? 'ja')
}

export default function JaShareWithAiRoute({
  loaderData,
}: Route.ComponentProps) {
  return <ShareWithAiPage locale={loaderData.locale} />
}
