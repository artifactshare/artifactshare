import type { ReactNode } from 'react'
import {
  AlertDialog,
  AlertDialogTrigger,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '~/components/ui/alert-dialog'
import { useT } from '~/hooks/use-t'

export function ConfirmActionDialog({
  open,
  onOpenChange,
  onConfirm,
  title,
  description,
  action,
  pending,
  pendingLabel,
  trigger,
  destructive = false,
  dismissLabel,
  result,
  awaitResult = false,
  returnFocusId,
  afterCloseFocus,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onConfirm: () => void
  title: string
  description: string
  action: string
  pendingLabel?: string
  pending: boolean
  destructive?: boolean
  dismissLabel?: string
  result?: ReactNode
  awaitResult?: boolean
  returnFocusId?: string
  afterCloseFocus?: () => void
  trigger?: ReactNode
}) {
  const { t } = useT()
  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (!pending) onOpenChange(next)
      }}
    >
      {trigger ? (
        <AlertDialogTrigger asChild>{trigger}</AlertDialogTrigger>
      ) : null}
      <AlertDialogContent
        size="sm"
        onCloseAutoFocus={(event) => {
          if (!returnFocusId) return
          const focusTarget = document.getElementById(returnFocusId)
          if (focusTarget) {
            event.preventDefault()
            focusTarget.focus()
          }
          afterCloseFocus?.()
        }}
      >
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        {result}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>
            {dismissLabel ?? t('confirm.cancel')}
          </AlertDialogCancel>
          <AlertDialogAction
            aria-busy={pending}
            variant={destructive ? 'destructive' : 'default'}
            disabled={pending}
            onClick={(event) => {
              if (awaitResult) event.preventDefault()
              if (!pending) onConfirm()
            }}
          >
            {pending ? (pendingLabel ?? t('confirm.pending')) : action}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
