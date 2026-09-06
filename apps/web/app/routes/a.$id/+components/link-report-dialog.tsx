import { type RefObject, useState, useId } from 'react'
import { Button } from '~/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '~/components/ui/dialog'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '~/components/ui/select'
import { Textarea } from '~/components/ui/textarea'
import { useT } from '~/hooks/use-t'
import { LINK_REPORT_REASONS, type LinkReportReason } from '~/lib/link-report'

type ReportDialogState = 'editing' | 'submitting' | 'sent' | 'error'

export function reportDialogStateOnReopen(
  state: ReportDialogState,
): ReportDialogState {
  return state === 'sent' || state === 'error' ? 'editing' : state
}

export function canSubmitLinkReport(
  reason: LinkReportReason | '',
  state: ReportDialogState,
): boolean {
  return reason !== '' && state !== 'submitting'
}

/**
 * Report dialog for content reached through a link share. Controlled by the
 * caller so the origin popover and sheet can open it.
 */
export function LinkReportDialog({
  shareableId,
  open,
  onOpenChange,
  returnFocusTo,
}: {
  shareableId: string
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Element to focus when the dialog closes (the caller's trigger). */
  returnFocusTo?: RefObject<HTMLElement | null>
}) {
  const { t } = useT()
  const reasonLabelId = useId()
  const [reason, setReason] = useState<LinkReportReason | ''>('')
  const [note, setNote] = useState('')
  const [state, setState] = useState<ReportDialogState>('editing')
  // Adjust state when `open` turns true, during render (no effect): a sent
  // report starts a fresh form, an error keeps the fields, a submission
  // continues. The caller keys this component by shareable, so a draft never
  // outlives the artifact it was written for.
  const [seenOpen, setSeenOpen] = useState(open)
  if (open !== seenOpen) {
    setSeenOpen(open)
    if (open) {
      if (state === 'sent') {
        setReason('')
        setNote('')
      }
      setState(reportDialogStateOnReopen(state))
    }
  }

  async function submit() {
    if (!reason) return
    setState('submitting')
    try {
      const response = await fetch(
        `/api/shareables/${encodeURIComponent(shareableId)}/report`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ reason, note }),
        },
      )
      setState(response.ok ? 'sent' : 'error')
    } catch {
      setState('error')
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        onCloseAutoFocus={(event) => {
          const target = returnFocusTo?.current
          // Only claim the return focus when the ⓘ is still shown.
          if (!target || !target.isConnected || target.offsetParent === null)
            return
          event.preventDefault()
          // The ⓘ sits in a clipped meta row; do not scroll it into view.
          target.focus({ preventScroll: true })
        }}
      >
        {state === 'sent' ? (
          <>
            <DialogHeader>
              <DialogTitle>{t('vw.linkSafety.thanksTitle')}</DialogTitle>
              <DialogDescription>
                {t('vw.linkSafety.thanksBody')}
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button onClick={() => onOpenChange(false)}>
                {t('vw.linkSafety.close')}
              </Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>{t('vw.linkSafety.reportTitle')}</DialogTitle>
              <DialogDescription>
                {t('vw.linkSafety.reportDescription')}
              </DialogDescription>
            </DialogHeader>
            <div className="grid gap-1.5">
              <span id={reasonLabelId} className="font-medium">
                {t('vw.linkSafety.reason')}
              </span>
              <Select
                value={reason}
                onValueChange={(value) => {
                  setReason(value as LinkReportReason)
                  if (state === 'error') setState('editing')
                }}
              >
                <SelectTrigger
                  className="w-full"
                  aria-labelledby={reasonLabelId}
                >
                  <SelectValue
                    placeholder={t('vw.linkSafety.reasonPlaceholder')}
                  />
                </SelectTrigger>
                <SelectContent>
                  {LINK_REPORT_REASONS.map((value) => (
                    <SelectItem key={value} value={value}>
                      {t(`vw.linkSafety.reason.${value}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <label className="grid gap-1.5">
              <span className="font-medium">{t('vw.linkSafety.note')}</span>
              <Textarea
                value={note}
                maxLength={500}
                onChange={(event) => {
                  setNote(event.currentTarget.value)
                  if (state === 'error') setState('editing')
                }}
                placeholder={t('vw.linkSafety.notePlaceholder')}
              />
              <span className="text-muted-foreground">
                {t('vw.linkSafety.noteGuidance')}
              </span>
            </label>
            {state === 'error' ? (
              <p className="text-destructive" role="alert">
                {t('vw.linkSafety.reportError')}
              </p>
            ) : null}
            <DialogFooter>
              <Button
                onClick={() => void submit()}
                disabled={!canSubmitLinkReport(reason, state)}
              >
                {state === 'submitting'
                  ? t('vw.linkSafety.submitting')
                  : t('vw.linkSafety.submit')}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}
