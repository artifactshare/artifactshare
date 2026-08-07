import { ConnectPage, connectMeta } from './connect'
import type { Route } from './+types/ja.connect'

export function loader() {
  return { locale: 'ja' as const }
}

export function meta({ loaderData }: Route.MetaArgs) {
  return connectMeta(loaderData?.locale ?? 'ja')
}

export default function JaConnectRoute({ loaderData }: Route.ComponentProps) {
  return <ConnectPage locale={loaderData.locale} />
}
