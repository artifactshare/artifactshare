import { data } from 'react-router'
import { analyticsConsentCookieHeader } from '~/lib/analytics-consent.server'
import type { Route } from './+types/set-analytics-consent'

export async function action({ request }: Route.ActionArgs) {
  // Reject cross-site submissions so a third-party page cannot force a consent
  // choice. Prefer Fetch Metadata (`Sec-Fetch-Site` is unforgeable across sites
  // and sent by modern browsers); fall back to an exact Origin match only for
  // clients that omit it.
  const site = request.headers.get('Sec-Fetch-Site')
  if (site) {
    if (site !== 'same-origin') return data(null, { status: 403 })
  } else {
    const origin = request.headers.get('Origin')
    if (origin !== new URL(request.url).origin)
      return data(null, { status: 403 })
  }

  const form = await request.formData()
  const value = form.get('consent')
  if (value !== 'granted' && value !== 'denied') {
    return data(null, { status: 400 })
  }

  return data(
    { consent: value },
    { headers: { 'Set-Cookie': analyticsConsentCookieHeader(value) } },
  )
}
