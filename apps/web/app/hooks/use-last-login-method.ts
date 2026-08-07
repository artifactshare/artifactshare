import { useRouteLoaderData } from 'react-router'

/**
 * The method used on the last sign-in, read from the root loader (which parses
 * the better-auth lastLoginMethod cookie). 'google' | 'microsoft' | 'email' |
 * null. SSR-resolved, so the "last used" hint renders on first paint.
 */
export function useLastLoginMethod(): string | null {
  const rootData = useRouteLoaderData('root') as
    | { lastLoginMethod?: string | null }
    | undefined
  return rootData?.lastLoginMethod ?? null
}
