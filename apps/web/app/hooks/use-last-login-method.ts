import { useRouteLoaderData } from 'react-router'

export function useLastLoginMethod(): string | null {
  const rootData = useRouteLoaderData('root') as
    | { lastLoginMethod?: string | null }
    | undefined
  return rootData?.lastLoginMethod ?? null
}
