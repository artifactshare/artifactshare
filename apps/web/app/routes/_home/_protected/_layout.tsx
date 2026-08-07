import { Outlet, useOutletContext } from 'react-router'
import { requireUserMiddleware } from '~/middleware/auth'
import type { HomeLayoutContext } from '../_layout'

export const middleware = [requireUserMiddleware]

export default function ProtectedHomeLayout() {
  const context = useOutletContext<HomeLayoutContext>()
  return <Outlet context={context} />
}
