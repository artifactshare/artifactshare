import { useFetcher } from 'react-router'
import { IconDots } from '@tabler/icons-react'
import { AuthorAvatar } from '~/components/app/author-avatar'
import { IconButton } from '~/components/app/icon-button'
import { Button } from '~/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '~/components/ui/dropdown-menu'
import { useT } from '~/hooks/use-t'

export type ParticipantsSummaryData = {
  count: number
  top: {
    id: string
    name: string | null
    email: string
    image: string | null
  }[]
}

// 詳細ヘッダの参加者表示。表示のみでクリック導線は付けない
// (購読の文脈に閲覧権の関係者一覧を混ぜない)。
export function ProjectParticipantsSummary({
  participants,
}: {
  participants: ParticipantsSummaryData
}) {
  const { t } = useT()
  if (participants.count === 0) return null
  return (
    <span className="text-muted-foreground inline-flex items-center gap-1.5 text-xs">
      <span className="inline-flex items-center -space-x-1.5">
        {participants.top.map((member) => (
          <AuthorAvatar
            key={member.id}
            id={member.email}
            image={member.image}
            initial={(member.name ?? member.email)[0]}
            size="xs"
          />
        ))}
      </span>
      {t('project.membersJoined', { count: participants.count })}
    </span>
  )
}

// 未参加なら「参加する」ボタン、参加中は ⋯ に「参加をやめる」だけを持つ
// 単独メニュー (編集メニューを持たない閲覧者・共有された関係者向け)。
export function ProjectMembershipControls({
  joined,
  showMenuWhenJoined = true,
}: {
  joined: boolean
  showMenuWhenJoined?: boolean
}) {
  const { t } = useT()
  const fetcher = useFetcher()
  if (!joined) {
    return (
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() =>
          fetcher.submit({ intent: 'join-project' }, { method: 'post' })
        }
      >
        {t('project.join')}
      </Button>
    )
  }
  if (!showMenuWhenJoined) return null
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <IconButton
          type="button"
          icon={IconDots}
          size="md"
          aria-label={t('project.membershipMenu')}
        />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem
          onSelect={() =>
            fetcher.submit({ intent: 'leave-project' }, { method: 'post' })
          }
        >
          {t('project.leave')}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
