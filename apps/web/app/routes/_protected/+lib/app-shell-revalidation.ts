import type { ShouldRevalidateFunctionArgs } from 'react-router'
import { searchQueryKeys } from '~/lib/search-query'
import { settingsShellShouldRevalidate } from '../settings/+lib/shell-revalidation'

/**
 * Whether a navigation only changes what the page shows inside itself: the
 * same page with another `tab`, or on `/search` other search conditions. The
 * header, the joined projects and the upload settings stay as they are.
 */
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

/**
 * When the shared header rereads the workspace name and the joined projects.
 *
 * - Moving to another page under the shell keeps them: the shell stays
 *   matched, so the router does not ask its loader again. Leaving the shell
 *   (a viewer, a public page) and coming back reads them once.
 * - Changing only the tab, or only the search conditions on `/search`, keeps
 *   them.
 * - A Settings submission that changes none of them keeps them, by the same
 *   table the Settings shell uses.
 * - Any other submission, an explicit revalidation, and any other query
 *   change follow the router's decision, which reads them again.
 */
export function appShellShouldRevalidate(args: ShouldRevalidateFunctionArgs) {
  if (isInPageQueryChange(args)) return false
  return settingsShellShouldRevalidate(args)
}
