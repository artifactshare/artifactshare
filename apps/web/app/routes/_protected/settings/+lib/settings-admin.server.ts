import {
  createContext,
  data,
  redirect,
  type MiddlewareFunction,
  type RouterContextProvider,
} from 'react-router'
import {
  settingsAdminPageAccess,
  settingsAdminPageFor,
} from '~/lib/settings-access'
import {
  settingsActiveRole,
  settingsWorkspace,
} from './settings-request.server'
import { planTier } from '~/lib/plan-tier'

/** The admin gate's decision for this request; unset means not decided. */
export const settingsAdminGate = createContext<'allowed' | 'forbidden' | null>(
  null,
)

/**
 * Decides once per request whether the viewer may open the admin-only Settings
 * page being requested. A viewer outside the Team plan is sent back to
 * Settings; any other refusal is recorded so the guarded handlers answer 403
 * while the Settings layout above them still loads and shows its error page.
 * Throwing here would skip those ancestor loaders.
 */
export const settingsAdminMiddleware: MiddlewareFunction<Response> = async (
  { context, pattern },
  next,
) => {
  const page = settingsAdminPageFor(pattern)
  const role = await settingsActiveRole(context)
  const isAdmin = role === 'owner' || role === 'admin'
  // The plan matters only to an admin opening Team-only inventory.
  const team =
    isAdmin &&
    page === 'inventory' &&
    planTier((await settingsWorkspace(context)).plan) === 'team'
  const decision = page
    ? settingsAdminPageAccess(page, { isAdmin, team })
    : 'forbidden'
  if (decision === 'not-team') throw redirect('/settings')
  context.set(settingsAdminGate, decision)
  return next()
}

/**
 * Every loader and action under the admin gate starts here, before any
 * protected read or write.
 */
export function requireSettingsAdminPage(
  context: Readonly<RouterContextProvider>,
) {
  if (context.get(settingsAdminGate) !== 'allowed')
    throw data('Forbidden', { status: 403 })
}
