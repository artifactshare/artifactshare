import { useNavigate, useSearchParams } from 'react-router'
import { AccessRequestsSheet } from '~/components/app/access-requests-sheet'

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
