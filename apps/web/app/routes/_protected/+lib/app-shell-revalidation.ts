import type { ShouldRevalidateFunctionArgs } from 'react-router'
import { searchQueryKeys } from '~/lib/search-query'
import { settingsShellShouldRevalidate } from '../settings/+lib/shell-revalidation'

export function isInPageQueryChange({
  currentUrl,
  nextUrl,
  formAction,
  formMethod,
  actionStatus,
}: ShouldRevalidateFunctionArgs) {
  if (formAction || actionStatus) return false
  if (formMethod && formMethod.toUpperCase() !== 'GET') return false
  if (currentUrl.pathname !== nextUrl.pathname) return false
  if (currentUrl.search === nextUrl.search) return false
  const currentParams = new URLSearchParams(currentUrl.search)
  const nextParams = new URLSearchParams(nextUrl.search)
  if (currentUrl.pathname === '/search') {
    for (const key of searchQueryKeys) {
      currentParams.delete(key)
      nextParams.delete(key)
    }
  }
  currentParams.delete('tab')
  nextParams.delete('tab')
  return currentParams.toString() === nextParams.toString()
}

export function appShellShouldRevalidate(args: ShouldRevalidateFunctionArgs) {
  if (isInPageQueryChange(args)) return false
  return settingsShellShouldRevalidate(args)
}
