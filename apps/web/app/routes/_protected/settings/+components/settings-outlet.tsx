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

function SettingsEntry({ shell }: { shell: SettingsLoaderData }) {
  const location = useLocation()
  const params = new URLSearchParams(location.search)
  const code = params.get('status')
  let external: string | null = null
  if (
    location.pathname === '/settings/billing' &&
    (code === 'checkout-success' || code === 'checkout-cancelled')
  )
    external = code
  if (location.pathname === '/settings/integrations') {
    if (
      code &&
      [
        'slack-team-in-use',
        'slack-team-mismatch',
        'not-found',
        'forbidden',
      ].includes(code)
    )
      external = code
    else if (params.get('connected') === 'slack') external = 'slack-connected'
  }
  // The notice belongs to the return entry. Cleaning its URL takes two steps:
  // the history entry is rewritten at once, so Back, Forward or a reload never
  // read the parameter again, and the router replaces its own location, with
  // no loader revalidation, so later submissions do not carry it. The notice
  // follows the entry that replace produces and is dropped on any other
  // navigation.
  const navigate = useNavigate()
  const navigationType = useNavigationType()
  const [notice, setNotice] = useState<{
    code: string
    pathname: string
    search: string
    entry: string | null
  } | null>(null)
  // While Stripe has not reported the new plan, Checkout stays replaced by the
  // pending notice on this page, including its other in-app views, so a second
  // purchase cannot start. Back, Forward and a reload start over.
  const [checkoutReturned, setCheckoutReturned] = useState(false)
  useEffect(() => {
    if (!external) {
      setNotice((previous) => {
        if (!previous || previous.entry === location.key) return previous
        const cleanupLanded =
          previous.entry === null &&
          navigationType === 'REPLACE' &&
          location.pathname === previous.pathname &&
          location.search === previous.search
        return cleanupLanded ? { ...previous, entry: location.key } : null
      })
      return
    }
    const kept = new URLSearchParams(location.search)
    kept.delete('status')
    if (location.pathname === '/settings/integrations')
      kept.delete('connected')
    const query = kept.toString()
    const search = query ? `?${query}` : ''
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
  const onNoticeEntry =
    notice !== null &&
    (notice.entry === location.key ||
      (notice.entry === null &&
        navigationType === 'REPLACE' &&
        location.pathname === notice.pathname &&
        location.search === notice.search))
  const result = external ?? (onNoticeEntry ? notice.code : null)
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
