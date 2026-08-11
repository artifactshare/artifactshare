import { useT } from '~/hooks/use-t'
import { ConfirmActionDialog } from './confirm-action-dialog'

interface RevokeCliSessionsDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onConfirm: () => void
  memberName: string
  pending: boolean
}

export function RevokeCliSessionsDialog({
  open,
  onOpenChange,
  onConfirm,
  memberName,
  pending,
}: RevokeCliSessionsDialogProps) {
  const { t } = useT()
  return (
    <ConfirmActionDialog
      open={open}
      onOpenChange={onOpenChange}
      onConfirm={onConfirm}
      title={t('team.members.revokeCliSessionsConfirm.title', {
        name: memberName,
      })}
      description={t('team.members.revokeCliSessionsConfirm.body')}
      action={t('team.members.revokeCliSessions')}
      pending={pending}
    />
  )
}
