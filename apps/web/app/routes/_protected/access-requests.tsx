import { useNavigate, useSearchParams } from 'react-router'
import { AccessRequestsSheet } from '~/components/app/access-requests-sheet'

export default function AccessRequestsPage() {
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  return (
    <main className="bg-background min-h-dvh">
      <AccessRequestsSheet
        open
        initialRequestId={searchParams.get('request')}
        onOpenChange={(open) => {
          if (!open) navigate('/')
        }}
      />
    </main>
  )
}
