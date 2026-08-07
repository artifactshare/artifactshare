import { redirect } from 'react-router'
import type { Route } from './+types/index'
import { requireUser } from '~/middleware/context'
import { createDb } from '~/services/db.server'
import { requireInventoryAccess } from '~/services/access.server'
export async function loader({ context }: Route.LoaderArgs) {
  const user = requireUser(context)
  await requireInventoryAccess(createDb(), user)
  throw redirect('/settings/inventory/projects')
}
export default function InventoryIndex() {
  return null
}
