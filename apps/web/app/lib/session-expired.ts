import { useEffect, useRef } from 'react'
import {
  isRouteErrorResponse,
  useLocation,
  useNavigate,
  useNavigation,
} from 'react-router'

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

export function signInReturnHref(location: {
  pathname: string
  search: string
  hash: string
}) {
  return `/?next=${encodeURIComponent(
    location.pathname + location.search + location.hash,
  )}`
}

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
