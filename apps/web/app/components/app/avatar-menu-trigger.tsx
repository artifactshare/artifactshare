import { DropdownMenuTrigger } from '~/components/ui/dropdown-menu'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '~/components/ui/tooltip'
import { AuthorAvatar } from './author-avatar'
import { guideFocusRingClassName } from './guide-styles'
import { useT } from '~/hooks/use-t'
import type { UserInfo } from '~/lib/user'
import { cn } from '~/lib/utils'

const triggerClassName = cn(
  'relative inline-flex size-6.5 shrink-0 cursor-pointer items-center justify-center rounded-full border-0 p-0 text-xs font-medium text-white shadow-[var(--shadow-inset-hairline)]',
  guideFocusRingClassName,
)

export function AvatarMenuTrigger({
  user,
  variant,
  className,
  accessRequestCount,
  showDot,
}: {
  user: UserInfo
  variant: 'default' | 'viewer'
  className?: string
  accessRequestCount: number
  showDot: boolean
}) {
  const { t } = useT()
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            data-avatar-menu-trigger
            className={cn(
              triggerClassName,
              variant === 'viewer' && 'max-phone:size-7.5',
              className,
            )}
            aria-label={
              accessRequestCount > 0
                ? t('accessRequests.pendingAccessible', {
                    count: accessRequestCount,
                    email: user.email,
                  })
                : showDot
                  ? t('updates.newAccessible', { email: user.email })
                  : user.email
            }
          >
            <AuthorAvatar
              id={user.id}
              image={user.image}
              initial={user.initial}
              size="menu"
              loading="eager"
              className={cn(
                'text-white',
                variant === 'viewer' && 'max-phone:size-7.5',
              )}
            />
            {(showDot || accessRequestCount > 0) && (
              <span
                aria-hidden="true"
                className="border-background bg-link absolute top-0 right-0 size-2.5 rounded-full border-2"
              />
            )}
          </button>
        </DropdownMenuTrigger>
      </TooltipTrigger>
      <TooltipContent sideOffset={variant === 'viewer' ? 24 : 0}>
        {user.email}
      </TooltipContent>
    </Tooltip>
  )
}
