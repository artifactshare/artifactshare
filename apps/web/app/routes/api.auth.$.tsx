import { authHandlerWithHangDetection } from '~/services/auth.server'
import type { Route } from './+types/api.auth.$'

// Tell the browser to drop cookies + localStorage / IndexedDB on sign-out so
// no UI prefs (locale, view mode) or stale auth tokens leak across sessions
// or accounts on a shared browser. Requires HTTPS — a no-op on http:// dev.
const CLEAR_SITE_DATA = '"cookies", "storage"'

function maybeClearSiteData(request: Request, response: Response): Response {
  if (!/\/sign-?out$/i.test(new URL(request.url).pathname)) return response
  const headers = new Headers(response.headers)
  headers.set('Clear-Site-Data', CLEAR_SITE_DATA)
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}

export async function loader({ request }: Route.LoaderArgs) {
  return maybeClearSiteData(
    request,
    await authHandlerWithHangDetection(request),
  )
}

export async function action({ request }: Route.ActionArgs) {
  return maybeClearSiteData(
    request,
    await authHandlerWithHangDetection(request),
  )
}
