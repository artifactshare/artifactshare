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
  const navigate = useNavigate()
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
  const [notice, setNotice] = useState<{
    code: string
    source: string
    entry?: string
  } | null>(null)
  const [checkoutReturned, setCheckoutReturned] = useState(false)
  useEffect(() => {
    if (!external) {
      setNotice((previous) => {
        if (!previous || previous.entry === location.key) return previous
        if (previous.entry || previous.source === location.key) return null
        return { ...previous, entry: location.key }
      })
      return
    }
    setNotice({ code: external, source: location.key })
    setCheckoutReturned(external === 'checkout-success')
    const search = new URLSearchParams(location.search)
    search.delete(external === 'slack-connected' ? 'connected' : 'status')
    // Clean this history entry at once. The router's replace below waits for
    // loaders, and a navigation started meanwhile would cancel it and leave
    // the return parameter in history for Back to replay.
    const query = search.toString()
    window.history.replaceState(
      window.history.state,
      '',
      location.pathname + (query ? `?${query}` : '') + location.hash,
    )
    void navigate(
      {
        pathname: location.pathname,
        search: search.toString(),
        hash: location.hash,
      },
      { replace: true, state: location.state, preventScrollReset: true },
    )
  }, [external, location, navigate])
  const result =
    external ??
    (notice && (!notice.entry || notice.entry === location.key)
      ? notice.code
      : null)
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
