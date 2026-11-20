import { redirect } from 'react-router'
import { requireUser } from '~/middleware/context'
import type { Route } from './+types/usage'
export function loader({ context }: Route.LoaderArgs) {
  requireUser(context)
  return redirect('/settings/billing')
}
