import { useT } from '~/hooks/use-t'
import { ConfirmActionDialog } from './confirm-action-dialog'

interface TransferOwnerDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onConfirm: () => void
  memberName: string
  pending: boolean
}

export function TransferOwnerDialog({
  open,
  onOpenChange,
  onConfirm,
  memberName,
  pending,
}: TransferOwnerDialogProps) {
  const { t } = useT()

  return (
    <ConfirmActionDialog
      open={open}
      onOpenChange={onOpenChange}
      onConfirm={onConfirm}
      title={t('team.members.transferOwnerConfirm.title', { name: memberName })}
      description={t('team.members.transferOwnerConfirm.body')}
      action={t('team.members.transferOwnerConfirm.action')}
      pending={pending}
    />
  )
}
