import { data } from 'react-router'
import type { Route } from './+types/set-analytics-tracked'
import { userContext } from '~/middleware/context'
import { createDb } from '~/services/db.server'
import { markPendingSignupTracked } from '~/services/signup-analytics.server'
import { firstTouchClearCookieHeader } from '~/lib/analytics/first-touch.server'
import { nowIso } from '~/lib/datetime'

export async function action({ request, context }: Route.ActionArgs) {
  const site = request.headers.get('Sec-Fetch-Site')
  if (
    site
      ? site !== 'same-origin'
      : request.headers.get('Origin') !== new URL(request.url).origin
  ) {
    return data(null, { status: 403 })
  }
  const user = context.get(userContext)
  if (!user) return data(null, { status: 401 })
  await markPendingSignupTracked(createDb(), user.id, nowIso())
  return data(
    { ok: true },
    { headers: { 'Set-Cookie': firstTouchClearCookieHeader() } },
  )
}
