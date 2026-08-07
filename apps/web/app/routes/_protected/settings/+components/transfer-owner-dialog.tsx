import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '~/components/ui/alert-dialog'
import { useT } from '~/hooks/use-t'

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
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent size="sm">
        <AlertDialogHeader>
          <AlertDialogTitle>
            {t('team.members.transferOwnerConfirm.title', {
              name: memberName,
            })}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {t('team.members.transferOwnerConfirm.body')}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>
            {t('confirm.cancel')}
          </AlertDialogCancel>
          <AlertDialogAction disabled={pending} onClick={onConfirm}>
            {t('team.members.transferOwnerConfirm.action')}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
