import { redirect } from 'react-router'
import type { Route } from './+types/activity'

export function loader(_: Route.LoaderArgs) {
  throw redirect('/')
}
