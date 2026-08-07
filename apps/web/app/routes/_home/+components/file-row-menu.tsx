import { IconDots } from '@tabler/icons-react'
import { useT } from '~/hooks/use-t'
import { Button } from '~/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '~/components/ui/dropdown-menu'

export function FileRowMenu({
  onCopyUrl,
  onAction,
  onPinToggle,
  pinned,
}: {
  onCopyUrl: () => void
  onAction?: (action: 'rename' | 'move' | 'visibility' | 'remove') => void
  onPinToggle?: () => void
  pinned?: boolean
}) {
  const { t } = useT()
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon-sm" aria-label={t('vw.more')}>
          <IconDots size={18} />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="min-w-38 [&_[role=menuitem]]:whitespace-nowrap"
      >
        <DropdownMenuItem onSelect={onCopyUrl}>
          {t('fileRowMenu.copyUrl')}
        </DropdownMenuItem>
        {onAction ? (
          <>
            <DropdownMenuItem onSelect={() => onAction('rename')}>
              {t('fileRowMenu.rename')}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => onAction('move')}>
              {t('fileRowMenu.move')}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => onAction('visibility')}>
              {t('fileRowMenu.visibility')}
            </DropdownMenuItem>
          </>
        ) : null}
        {onPinToggle ? (
          <DropdownMenuItem onSelect={onPinToggle}>
            {t(pinned ? 'project.unpin' : 'project.pin')}
          </DropdownMenuItem>
        ) : null}
        {onAction ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              variant="destructive"
              onSelect={() => onAction('remove')}
            >
              {t('fileRowMenu.remove')}
            </DropdownMenuItem>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
