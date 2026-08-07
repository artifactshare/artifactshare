import { useNavigate, useRevalidator } from 'react-router'
import { toast } from 'sonner'
import { useT } from '~/hooks/use-t'

export function useRemoveArtifact(artifactId: string) {
  const { t } = useT()
  const navigate = useNavigate()
  const revalidator = useRevalidator()

  return async () => {
    const res = await fetch(`/api/artifacts/${artifactId}`, {
      method: 'DELETE',
    })
    if (!res.ok) {
      toast.error('Failed to remove')
      return
    }
    toast(t('toast.removed'))
    revalidator.revalidate()
    navigate('/')
  }
}
