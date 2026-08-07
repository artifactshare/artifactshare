import { Outlet } from 'react-router'
import { requireUserMiddleware } from '~/middleware/auth'

export const middleware = [requireUserMiddleware]

export default function ProtectedLayout() {
  return <Outlet />
}
