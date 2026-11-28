import { createContext, type RouterContextProvider } from 'react-router'
import type { SessionUser } from '~/lib/user'
import type { CliAuthority } from '~/services/cli-authority.server'

export const userContext = createContext<SessionUser | null>(null)
export const authSourceContext = createContext<'cookie' | 'bearer' | null>(null)
export const cliAuthorityContext = createContext<CliAuthority | null>(null)
export const linkDomainContext = createContext<{ shareableId: string } | null>(
  null,
)

export const ctxContext = createContext<ExecutionContext>()

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

export function getCliAuthority(
  context: Readonly<RouterContextProvider>,
): CliAuthority | null {
  return context.get(cliAuthorityContext)
}
