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
import type { TeamMember } from '~/lib/team-management'
import { RecipientPicker } from './recipient-picker'

export { NO_ASSET_TRANSFER } from './recipient-picker'

interface RemoveMemberDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onConfirm: () => void
  memberName: string
  pending: boolean
  currentUser: TeamMember
  excludeUserId: string
  recipientUserId: string
  onRecipientUserIdChange: (userId: string) => void
}

export function RemoveMemberDialog({
  open,
  onOpenChange,
  onConfirm,
  memberName,
  pending,
  currentUser,
  excludeUserId,
  recipientUserId,
  onRecipientUserIdChange,
}: RemoveMemberDialogProps) {
  const { t } = useT()

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent size="sm">
        <AlertDialogHeader>
          <AlertDialogTitle>
            {t('team.members.removeConfirm.title', { name: memberName })}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {t('team.members.removeConfirm.body')}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <RecipientPicker
          excludeUserId={excludeUserId}
          currentUser={currentUser}
          value={recipientUserId}
          onChange={onRecipientUserIdChange}
          disabled={pending}
          allowNone
        />
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>
            {t('confirm.cancel')}
          </AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            disabled={pending}
            onClick={onConfirm}
          >
            {t('team.members.removeConfirm.action')}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
