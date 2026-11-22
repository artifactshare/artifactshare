import { useEffect, useState } from 'react'
import { Outlet, useLocation, useNavigationType } from 'react-router'
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
  // Remove the return parameter from this history entry at once, without a
  // router navigation: the router keeps this entry's location, so the notice
  // shows here only, and Back, Forward or a reload read the cleaned URL. A
  // router replace would wait for loaders and could be cancelled by the next
  // navigation, leaving the parameter in history or the notice on another
  // entry.
  useEffect(() => {
    if (!external) return
    const search = new URLSearchParams(location.search)
    search.delete(external === 'slack-connected' ? 'connected' : 'status')
    const query = search.toString()
    window.history.replaceState(
      window.history.state,
      '',
      location.pathname + (query ? `?${query}` : '') + location.hash,
    )
  }, [external, location])
  const result = external
  return (
    <>
      {result && <StatusBanner status={result} />}
      <Outlet
        context={{
          ...shell,
          externalResult: result,
        }}
      />
    </>
  )
}
