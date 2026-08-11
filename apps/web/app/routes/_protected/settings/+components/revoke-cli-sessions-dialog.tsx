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
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent size="sm">
        <AlertDialogHeader>
          <AlertDialogTitle>
            {t('team.members.revokeCliSessionsConfirm.title', {
              name: memberName,
            })}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {t('team.members.revokeCliSessionsConfirm.body')}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>
            {t('confirm.cancel')}
          </AlertDialogCancel>
          <AlertDialogAction disabled={pending} onClick={onConfirm}>
            {t('team.members.revokeCliSessions')}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
