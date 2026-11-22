import { useState, type ComponentProps } from 'react'
import { useT } from '~/hooks/use-t'
import { displayName, type TeamMember } from '~/lib/team-management'
import { RecipientPicker } from './recipient-picker'
import { ConfirmActionDialog } from './confirm-action-dialog'

type Props = Omit<
  ComponentProps<typeof ConfirmActionDialog>,
  'onConfirm' | 'title' | 'description' | 'action'
> & {
  currentUser: TeamMember
  member: TeamMember
  intent: 'remove-member' | 'transfer-removed-assets'
  committed: boolean
  // A request that may have reached the server is retried unchanged.
  interrupted: boolean
  submit: (recipient: string) => void
}

export function RemoveMemberDialog({
  member,
  currentUser,
  intent,
  committed,
  interrupted,
  submit,
  result,
  ...dialog
}: Props) {
  const { t } = useT()
  const [selection, setSelection] = useState<string | null>(null)
  const recipient = selection ?? currentUser.id
  const remove = intent === 'remove-member'
  const copy = remove
    ? 'team.members.removeConfirm'
    : 'team.removedMembers.transferConfirm'
  return (
    <ConfirmActionDialog
      {...dialog}
      destructive={remove}
      title={t(`${copy}.title`, { name: displayName(member) })}
      description={t(`${copy}.body`, { name: displayName(member) })}
      action={committed ? null : t(`${copy}.action`)}
      onConfirm={() => submit(recipient)}
      result={
        <>
          <RecipientPicker
            currentUser={currentUser}
            excludeUserId={member.id}
            value={recipient}
            onChange={setSelection}
            disabled={dialog.pending || committed || interrupted}
            allowNone={remove}
          />
          {result}
        </>
      }
    />
  )
}
