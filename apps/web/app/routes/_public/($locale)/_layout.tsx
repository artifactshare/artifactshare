import { Outlet } from 'react-router'

import { resolvePublicRouteLocale } from '~/lib/public-route-locale'
import type { Route } from './+types/_layout'

export function loader({ params }: Route.LoaderArgs) {
  return { locale: resolvePublicRouteLocale(params.locale) }
}

export default function PublicLocaleLayout() {
  return <Outlet />
}
