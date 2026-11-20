import { redirect } from 'react-router'
import { requireUser } from '~/middleware/context'
import type { Route } from './+types/cli-sessions'
export function loader({ context }: Route.LoaderArgs) {
  requireUser(context)
  return redirect('/settings/tokens')
}
