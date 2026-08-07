import { createContext, type RouterContextProvider } from 'react-router'
import type { SessionUser } from '~/lib/user'

/**
 * Resolved session user for the current request, or null if anonymous.
 * Populated by `sessionMiddleware` at the root layer.
 */
export const userContext = createContext<SessionUser | null>(null)
export const authSourceContext = createContext<'cookie' | 'bearer' | null>(null)

/**
 * The Worker's ExecutionContext for this request — used for `waitUntil` to
 * fire-and-forget background tasks safely. Populated in workers/app.ts.
 */
export const ctxContext = createContext<ExecutionContext>()

/**
 * Read the user from a route protected by `requireUserMiddleware`.
 * Throws loud if called from a route lacking the middleware — better than
 * `!` assertions silently coercing null.
 */
export function requireUser(
  context: Readonly<RouterContextProvider>,
): SessionUser {
  const user = context.get(userContext)
  if (!user) {
    throw new Error(
      'requireUser called from a route without requireUserMiddleware',
    )
  }
  return user
}
