import type { useFetcher } from 'react-router'
import { displayName, type TeamMember } from '~/lib/team-management'
import { useT } from '~/hooks/use-t'
import type { action } from '../_content/index'
import { RemoveMemberDialog } from './remove-member-dialog'
import { TransferOwnerDialog } from './transfer-owner-dialog'
import { ConfirmActionDialog } from './confirm-action-dialog'
import { StatusBanner } from './settings-banner'

const memberLabels = {
  'grant-admin': [
    'team.members.makeAdmin',
    'team.members.grantAdminBody',
    'team.members.makeAdmin',
  ],
  'revoke-admin': [
    'team.members.removeAdmin',
    'team.members.revokeAdminBody',
    'team.members.removeAdmin',
  ],
  'revoke-cli-sessions': [
    'team.members.revokeCliSessionsConfirm.title',
    'team.members.revokeCliSessionsConfirm.body',
    'team.members.revokeCliSessions',
  ],
  'restore-member': [
    'team.removedMembers.restoreConfirm.title',
    'team.removedMembers.restoreConfirm.body',
    'team.removedMembers.restoreConfirm.action',
  ],
} as const

type MemberIntent =
  | keyof typeof memberLabels
  | 'transfer-owner'
  | 'remove-member'
  | 'transfer-removed-assets'

export function isMemberConfirmation(intent: string): intent is MemberIntent {
  return (
    intent === 'transfer-owner' ||
    intent === 'remove-member' ||
    intent === 'transfer-removed-assets' ||
    Object.hasOwn(memberLabels, intent)
  )
}

export type MemberTarget = {
  intent: MemberIntent
  member: TeamMember
  triggerId: string
}
export function MemberConfirmation({
  target,
  currentUser,
  close,
  fetcher,
}: {
  target: MemberTarget
  currentUser: TeamMember
  close: () => void
  fetcher: ReturnType<typeof useFetcher<typeof action>>
}) {
  const { t } = useT()
  const { intent, member } = target
  const result = fetcher.state === 'idle' ? fetcher.data : undefined
  const committed = !!(
    result &&
    'removalCommitted' in result &&
    result.removalCommitted
  )
  const props = {
    open: true,
    awaitResult: true,
    pending: fetcher.state !== 'idle',
    returnFocusId: target.triggerId,
    fallbackFocusId: committed
      ? `transfer-removed-assets-${member.id}`
      : 'member-search',
    onOpenChange: (open: boolean) => {
      if (!open) close()
    },
    result: result && !result.ok && <StatusBanner status={result.code} />,
  }
  const submit = (recipientUserId?: string) => {
    void fetcher.submit(
      {
        intent,
        userId: member.id,
        ...(recipientUserId && { recipientUserId }),
      },
      { method: 'post', action: '/settings?index' },
    )
  }
  if (intent === 'remove-member' || intent === 'transfer-removed-assets')
    return (
      <RemoveMemberDialog
        {...props}
        member={member}
        currentUser={currentUser}
        intent={intent}
        committed={committed}
        submit={submit}
      />
    )
  if (intent === 'transfer-owner')
    return (
      <TransferOwnerDialog
        {...props}
        memberName={displayName(member)}
        onConfirm={() => submit()}
      />
    )
  const [title, description, label] = memberLabels[intent]
  return (
    <ConfirmActionDialog
      {...props}
      title={t(title, { name: displayName(member) })}
      description={t(description, { name: displayName(member) })}
      action={t(label)}
      onConfirm={() => submit()}
    />
  )
}
