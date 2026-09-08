import { useId } from 'react'
import { Button } from '~/components/ui/button'
import { DialogFooter } from '~/components/ui/dialog'
import { Input } from '~/components/ui/input'
import { useCopyState } from '~/hooks/use-copy-state'
import { useT } from '~/hooks/use-t'
import { buildShareableUrl } from '~/lib/share-url'
import { dialogNoteWarnClassName } from './dialog-note-styles'

export function VisibilityDialogActions({
  hasPendingChanges,
  saving,
  saveDisabled,
  onCancel,
  onSave,
  cancelLabel,
  primaryLabel,
  savingLabel,
}: {
  hasPendingChanges: boolean
  saving: boolean
  saveDisabled: boolean
  onCancel: () => void
  onSave: () => void
  cancelLabel: string
  primaryLabel: string
  savingLabel: string
}) {
  return (
    <DialogFooter className="sm:items-center">
      <p
        className={
          saving
            ? 'text-muted-foreground order-1 text-sm sm:order-none sm:mr-auto'
            : 'sr-only'
        }
        role="status"
        aria-live="polite"
      >
        {saving ? savingLabel : ''}
      </p>
      {hasPendingChanges ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={onCancel}
          disabled={saving}
        >
          {cancelLabel}
        </Button>
      ) : null}
      <Button
        type="button"
        size="sm"
        onClick={onSave}
        disabled={saving || (hasPendingChanges && saveDisabled)}
      >
        {primaryLabel}
      </Button>
    </DialogFooter>
  )
}

export function LinkVisibilitySection({
  shareableId,
  available,
  expired,
  suspended = false,
  saving,
  expiryDate,
  expiryInvalid,
  minimumDate,
  maximumDate,
  unlimited,
  showUnlimited,
  onExpiryDateChange,
  onUnlimitedChange,
  onRepublish,
  showActions,
}: {
  shareableId: string
  available: boolean
  expired: boolean
  suspended?: boolean
  saving: boolean
  expiryDate: string | null
  expiryInvalid: boolean
  minimumDate: string
  maximumDate?: string
  unlimited: boolean
  showUnlimited: boolean
  onExpiryDateChange: (value: string) => void
  onUnlimitedChange: (value: boolean) => void
  onRepublish: () => void
  showActions: boolean
}) {
  const { t } = useT()
  const expiryInputId = useId()
  const expiryDescriptionId = useId()
  const url = buildShareableUrl(shareableId, 'link')
  const { state, copy } = useCopyState(url)
  return (
    <>
      <p className={dialogNoteWarnClassName}>
        {t('visibilityDialog.link.warn')}
      </p>
      {!available ? (
        <p className="text-warning text-sm">
          {t('visibilityDialog.link.unavailable')}
        </p>
      ) : null}
      {suspended ? (
        <p className="border-warning/40 bg-warning-soft rounded-[var(--r-md)] border p-3 text-sm">
          {t('visibilityDialog.link.suspended')}
          {expired ? ` ${t('visibilityDialog.link.expired')}` : null}
        </p>
      ) : null}
      {expired && !suspended ? (
        <div className="border-warning/40 bg-warning-soft flex flex-col gap-2 rounded-[var(--r-md)] border p-3 text-sm">
          <span>{t('visibilityDialog.link.expired')}</span>
          {available ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={saving}
              onClick={onRepublish}
            >
              {t('visibilityDialog.link.republish')}
            </Button>
          ) : null}
        </div>
      ) : null}
      <div className="flex flex-col gap-1 text-sm">
        <label htmlFor={expiryInputId} className="font-medium">
          {t('visibilityDialog.link.expiry')}
        </label>
        <Input
          id={expiryInputId}
          type="date"
          value={unlimited ? '' : (expiryDate ?? '')}
          min={minimumDate}
          max={maximumDate}
          disabled={saving || unlimited || !available}
          aria-invalid={expiryInvalid || undefined}
          aria-describedby={expiryDescriptionId}
          onChange={(event) => onExpiryDateChange(event.currentTarget.value)}
        />
        <span
          id={expiryDescriptionId}
          className={expiryInvalid ? 'text-warning text-sm' : 'sr-only'}
          role="status"
          aria-live="polite"
        >
          {expiryInvalid
            ? t(
                showUnlimited
                  ? 'visibilityDialog.link.expiryRequiredOrUnlimited'
                  : 'visibilityDialog.link.expiryRequired',
              )
            : ''}
        </span>
      </div>
      {showUnlimited ? (
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={unlimited}
            disabled={saving || !available}
            onChange={(event) => onUnlimitedChange(event.currentTarget.checked)}
          />
          {t('visibilityDialog.link.unlimited')}
        </label>
      ) : null}
      {showActions ? (
        <div className="flex flex-col gap-2">
          <div className="border-border bg-muted flex items-center gap-2 rounded-[var(--r-md)] border p-2">
            <Input
              value={url}
              readOnly
              aria-label={t('visibilityDialog.link.urlLabel')}
              className="text-muted-foreground flex-1 text-sm"
              onFocus={(event) => event.currentTarget.select()}
            />
            <Button type="button" size="sm" onClick={copy}>
              {t('visibilityDialog.link.copyButton')}
            </Button>
          </div>
          <span
            className={
              state === 'idle'
                ? 'sr-only'
                : state === 'failed'
                  ? 'text-warning text-sm'
                  : 'text-muted-foreground text-sm'
            }
            role="status"
            aria-live="polite"
            data-copy-status
          >
            {state === 'idle'
              ? ''
              : state === 'copied'
                ? t('visibilityDialog.link.copied')
                : t('visibilityDialog.link.copyFailed')}
          </span>
          <Button variant="outline" size="sm" asChild>
            <a target="_blank" rel="noopener noreferrer" href={url}>
              {t('visibilityDialog.link.openAsRecipient')}
            </a>
          </Button>
        </div>
      ) : null}
    </>
  )
}
