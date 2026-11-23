import { useEffect, useRef } from 'react'
import {
  isRouteErrorResponse,
  useLocation,
  useNavigate,
  useNavigation,
} from 'react-router'

/**
 * What a confirmation resource answers when the session ran out while the
 * confirmation was open. The resource itself replies 401; its client loader
 * turns that into this value so the confirmation, not a route error, decides
 * what happens next.
 */
export type SessionExpired = { kind: 'session-expired' }

export function isSessionExpired(value: unknown): value is SessionExpired {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { kind?: unknown }).kind === 'session-expired'
  )
}

export async function readConfirmationResource<T>(
  serverLoader: () => Promise<T>,
): Promise<T | SessionExpired> {
  try {
    return await serverLoader()
  } catch (error) {
    if (isRouteErrorResponse(error) && error.status === 401)
      return { kind: 'session-expired' }
    throw error
  }
}

/** The sign-in entry that returns to the given page after sign-in. */
export function signInReturnHref(location: {
  pathname: string
  search: string
  hash: string
}) {
  return `/?next=${encodeURIComponent(
    location.pathname + location.search + location.hash,
  )}`
}

/**
 * Sends the user to sign in, returning to the page they are on, when an open
 * confirmation learns that the session expired. `openedOn` is the history
 * entry the confirmation was opened on, or null while it is closed. A result
 * that arrives after the confirmation closed, after the user moved to another
 * entry or while they are moving away is ignored.
 */
export function useSignInOnSessionExpired(
  data: unknown,
  openedOn: string | null,
) {
  const navigate = useNavigate()
  const location = useLocation()
  const navigation = useNavigation()
  const expired =
    openedOn === location.key &&
    navigation.state === 'idle' &&
    isSessionExpired(data)
  const sent = useRef(false)
  useEffect(() => {
    if (!expired || sent.current) return
    sent.current = true
    void navigate(signInReturnHref(location))
  }, [expired, location, navigate])
}
