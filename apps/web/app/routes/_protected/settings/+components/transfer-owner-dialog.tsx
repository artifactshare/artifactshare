import type { ComponentProps } from 'react'
import { useT } from '~/hooks/use-t'
import { ConfirmActionDialog } from './confirm-action-dialog'

type Props = Omit<
  ComponentProps<typeof ConfirmActionDialog>,
  'title' | 'description' | 'action'
> & { memberName: string }

export function TransferOwnerDialog({ memberName, ...dialog }: Props) {
  const { t } = useT()
  return (
    <ConfirmActionDialog
      {...dialog}
      title={t('team.members.transferOwnerConfirm.title', { name: memberName })}
      description={t('team.members.transferOwnerConfirm.body')}
      action={t('team.members.transferOwnerConfirm.action')}
    />
  )
}
