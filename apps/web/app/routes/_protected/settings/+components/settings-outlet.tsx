import { useEffect, useState } from 'react'
import {
  Outlet,
  useLocation,
  useNavigate,
  useNavigationType,
} from 'react-router'
import { StatusBanner } from './settings-banner'
import type { SettingsLoaderData } from '../_layout'

/**
 * A key that changes only when the user moves through history (Back, Forward
 * or a reload). Submission results, open confirmations and their fetchers
 * belong to the history entry that produced them, so moving to another entry
 * remounts the page; in-app navigations keep it mounted with its form state.
 */
function useHistoryEntryKey() {
  const location = useLocation()
  const navigationType = useNavigationType()
  const [seen, setSeen] = useState({ key: location.key, generation: 0 })
  if (seen.key !== location.key)
    setSeen({
      key: location.key,
      generation: seen.generation + (navigationType === 'POP' ? 1 : 0),
    })
  return seen.generation
}

export function SettingsOutlet({ shell }: { shell: SettingsLoaderData }) {
  const entryKey = useHistoryEntryKey()
  return <SettingsEntry key={entryKey} shell={shell} />
}

const INTEGRATION_RETURNS = [
  'slack-team-in-use',
  'slack-team-mismatch',
  'not-found',
  'forbidden',
]

/** The notice a return from Stripe Checkout or a Slack install asks for. */
function externalReturn({
  pathname,
  search,
}: {
  pathname: string
  search: string
}) {
  const params = new URLSearchParams(search)
  const code = params.get('status')
  if (pathname === '/settings/billing')
    return code === 'checkout-success' || code === 'checkout-cancelled'
      ? code
      : null
  if (pathname !== '/settings/integrations') return null
  if (code && INTEGRATION_RETURNS.includes(code)) return code
  return params.get('connected') === 'slack' ? 'slack-connected' : null
}

/** The URL of the return entry without the parameters it consumed. */
function cleanedSearch({
  pathname,
  search,
}: {
  pathname: string
  search: string
}) {
  const kept = new URLSearchParams(search)
  kept.delete('status')
  if (pathname === '/settings/integrations') kept.delete('connected')
  const query = kept.toString()
  return query ? `?${query}` : ''
}

type ReturnNotice = {
  code: string
  pathname: string
  search: string
  entry: string | null
}

/** Whether this location is the entry the notice's cleanup replace made. */
function cleanupLanded(
  notice: ReturnNotice,
  location: { pathname: string; search: string },
  navigationType: string,
) {
  return (
    notice.entry === null &&
    navigationType === 'REPLACE' &&
    location.pathname === notice.pathname &&
    location.search === notice.search
  )
}

/**
 * The notice belongs to the return entry. Cleaning its URL takes two steps:
 * the history entry is rewritten at once, so Back, Forward or a reload never
 * read the parameter again, and the router replaces its own location, with
 * no loader revalidation, so later submissions do not carry it. The notice
 * follows the entry that replace produces and is dropped on any other
 * navigation.
 *
 * While Stripe has not reported the new plan, Checkout stays replaced by the
 * pending notice on this page, including its other in-app views, so a second
 * purchase cannot start. Back, Forward and a reload start over.
 */
function useReturnNotice() {
  const location = useLocation()
  const navigate = useNavigate()
  const navigationType = useNavigationType()
  const external = externalReturn(location)
  const [notice, setNotice] = useState<ReturnNotice | null>(null)
  const [checkoutReturned, setCheckoutReturned] = useState(false)
  useEffect(() => {
    if (!external) {
      setNotice((previous) => {
        if (!previous || previous.entry === location.key) return previous
        return cleanupLanded(previous, location, navigationType)
          ? { ...previous, entry: location.key }
          : null
      })
      return
    }
    const search = cleanedSearch(location)
    window.history.replaceState(
      window.history.state,
      '',
      location.pathname + search + location.hash,
    )
    if (external === 'checkout-success') setCheckoutReturned(true)
    setNotice({
      code: external,
      pathname: location.pathname,
      search,
      entry: null,
    })
    void navigate(
      { pathname: location.pathname, search, hash: location.hash },
      {
        replace: true,
        state: location.state,
        preventScrollReset: true,
        defaultShouldRevalidate: false,
      },
    )
  }, [external, location, navigationType, navigate])
  const shown =
    notice !== null &&
    (notice.entry === location.key ||
      cleanupLanded(notice, location, navigationType))
  const result = external ?? (shown ? notice.code : null)
  return { result, checkoutReturned }
}

function SettingsEntry({ shell }: { shell: SettingsLoaderData }) {
  const { result, checkoutReturned } = useReturnNotice()
  return (
    <>
      {result && <StatusBanner status={result} />}
      <Outlet
        context={{
          ...shell,
          externalResult: checkoutReturned ? 'checkout-success' : result,
        }}
      />
    </>
  )
}
