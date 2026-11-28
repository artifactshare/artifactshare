import { data } from 'react-router'
import { analyticsConsentCookieHeader } from '~/lib/analytics-consent.server'
import type { Route } from './+types/set-analytics-consent'

export async function action({ request }: Route.ActionArgs) {
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
