import { redirect, useNavigate, useSearchParams } from 'react-router'
import { AccessRequestsSheet } from '~/components/app/access-requests-sheet'
import { requireUser } from '~/middleware/context'
import { createDb } from '~/services/db.server'
import { getReceivedAccessRequestTarget } from '~/services/access-requests.server'
import type { Route } from './+types/access-requests'

export async function loader({ url, context }: Route.LoaderArgs) {
  const requestId = url.searchParams.get('request')
  if (!requestId) return null

  const user = requireUser(context)
  const target = await getReceivedAccessRequestTarget(
    createDb(),
    requestId,
    user,
  )
  if (!target?.canView) return null

  const destination = new URL(
    `/a/${encodeURIComponent(target.shareableId)}`,
    url,
  )
  destination.searchParams.set('access-request', requestId)
  return redirect(`${destination.pathname}${destination.search}`)
}

export default function AccessRequestsPage() {
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const requestId = searchParams.get('request')
  return (
    <main className="bg-background min-h-dvh">
      <AccessRequestsSheet
        key={requestId ?? 'list'}
        open
        initialRequestId={requestId}
        onOpenChange={(open) => {
          if (!open) navigate('/')
        }}
      />
    </main>
  )
}
