import { useState } from 'react'
import { Button } from '~/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
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

export function LinkShareSafetyBanner({
  shareableId,
}: {
  shareableId: string
}) {
  const { t } = useT()
  const [open, setOpen] = useState(false)
  const [reason, setReason] = useState<LinkReportReason | ''>('')
  const [note, setNote] = useState('')
  const [state, setState] = useState<ReportDialogState>('editing')

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
    <div className="border-border bg-background flex shrink-0 items-center justify-between gap-2 border-b py-2 pr-16 pl-3 text-xs sm:gap-3 sm:text-sm">
      <p className="min-w-0 leading-snug">{t('vw.linkSafety.disclaimer')}</p>
      <Dialog
        open={open}
        onOpenChange={(nextOpen) => {
          setOpen(nextOpen)
          if (nextOpen && (state === 'sent' || state === 'error')) {
            if (state === 'sent') {
              setReason('')
              setNote('')
            }
            setState(reportDialogStateOnReopen(state))
          }
        }}
      >
        <DialogTrigger asChild>
          <Button
            variant="outline"
            size="sm"
            className="h-7 shrink-0 px-2 sm:h-8 sm:px-3"
            data-link-report-trigger
          >
            {t('vw.linkSafety.report')}
          </Button>
        </DialogTrigger>
        <DialogContent>
          {state === 'sent' ? (
            <>
              <DialogHeader>
                <DialogTitle>{t('vw.linkSafety.thanksTitle')}</DialogTitle>
                <DialogDescription>
                  {t('vw.linkSafety.thanksBody')}
                </DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <Button onClick={() => setOpen(false)}>
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
              <label className="grid gap-1.5">
                <span className="font-medium">{t('vw.linkSafety.reason')}</span>
                <Select
                  value={reason}
                  onValueChange={(value) => {
                    setReason(value as LinkReportReason)
                    if (state === 'error') setState('editing')
                  }}
                >
                  <SelectTrigger className="w-full">
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
              </label>
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
    </div>
  )
}
