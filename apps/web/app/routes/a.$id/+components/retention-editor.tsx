import { retentionSummary } from './retention-copy'
import { useId, useRef, useState, type RefObject } from 'react'
import { useRevalidator } from 'react-router'
import { Button } from '~/components/ui/button'
import { Input } from '~/components/ui/input'
import { RadioGroup, RadioGroupItem } from '~/components/ui/radio-group'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '~/components/ui/alert-dialog'
import { useT } from '~/hooks/use-t'
import { cn } from '~/lib/utils'

type Preview = { count: number; proposed: number | null; snapshot: string }
export function RetentionEditor({
  artifactId,
  retainVersions,
  publisherManaged,
  extraProtectedCurrentVersion,
}: {
  artifactId: string
  publisherManaged?: boolean
  extraProtectedCurrentVersion?: boolean
  retainVersions: number | null
}) {
  const { t } = useT()
  const id = useId()
  const revalidator = useRevalidator()
  // Until edited, follow loader updates without remounting the controls.
  // A draft also freezes submitted values through pending, confirmation and failure.
  const [draft, setDraft] = useState<{
    limited: boolean
    count: string
  } | null>(null)
  const limited = draft?.limited ?? retainVersions !== null
  const count = draft?.count ?? String(retainVersions ?? 1)
  const [expanded, setExpanded] = useState(false)
  const [saved, setSaved] = useState(false)
  const changeButton = useRef<HTMLButtonElement>(null)
  const [pendingRequest, setPendingRequest] = useState<symbol | null>(null)
  const pending = pendingRequest !== null
  const busy = useRef<symbol | null>(null)
  const saveButton = useRef<HTMLButtonElement>(null)
  const [error, setError] = useState<'failed' | 'changed' | null>(null)
  const [preview, setPreview] = useState<Preview | null>(null)
  const { proposed, valid } = retentionProposal(limited, count)
  const unchanged = proposed === retainVersions
  function editDraft(next: { limited: boolean; count: string }) {
    setDraft(next)
    setSaved(false)
    setError(null)
  }
  async function save(confirmed?: Preview) {
    if (busy.current || !valid || unchanged) return
    const request = Symbol()
    busy.current = request
    setDraft({ limited, count })
    setPendingRequest(request)
    setError(null)
    setSaved(false)
    try {
      const response = await fetch(
        `/api/shareables/${encodeURIComponent(artifactId)}/retention`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            operation: 'save',
            retain_versions: confirmed ? confirmed.proposed : proposed,
            ...(confirmed ? { snapshot: confirmed.snapshot } : {}),
          }),
        },
      )
      if (response.status === 409) {
        const result = (await response.json()) as Preview & { kind: string }
        if (busy.current !== request) return
        if (result.kind !== 'preview') throw new Error('invalid preview')
        if (result.count > 0) {
          setPreview(result)
          if (confirmed) setError('changed')
        } else {
          setPreview((current) =>
            current === (confirmed ?? null) ? null : current,
          )
          setError('changed')
        }
        return
      }
      if (!response.ok) throw new Error('save failed')
      const result = (await response.json()) as { kind: string }
      if (result.kind !== 'saved') throw new Error('invalid save response')
      await revalidator.revalidate()
      if (busy.current !== request) return
      setDraft(null)
      setPreview((current) =>
        current === (confirmed ?? null) ? null : current,
      )
      setSaved(true)
    } catch {
      setError('failed')
    } finally {
      if (busy.current === request) busy.current = null
      setPendingRequest((current) => (current === request ? null : current))
    }
  }
  return (
    <>
      <div className="flex items-center justify-between gap-2">
        <p
          className={cn(
            'text-muted-foreground min-w-0 text-sm',
            !publisherManaged && 'truncate',
          )}
        >
          {retentionSummary(
            retainVersions,
            publisherManaged,
            t,
            extraProtectedCurrentVersion,
          )}
        </p>
        <Button
          data-retention-change
          ref={changeButton}
          type="button"
          variant="ghost"
          className="shrink-0"
          aria-expanded={expanded}
          aria-controls={`${id}-editor`}
          disabled={pending}
          onClick={() => setExpanded(!expanded)}
        >
          {t(expanded ? 'common.close' : 'vw.retentionChange')}
        </Button>
      </div>
      <form
        id={`${id}-editor`}
        hidden={!expanded}
        className={expanded ? 'flex flex-col gap-3' : undefined}
        aria-busy={pending}
        onSubmit={(event) => {
          event.preventDefault()
          void save()
        }}
      >
        <Button
          data-retention-save
          ref={saveButton}
          type="submit"
          variant="outline"
          disabled={pending || !valid || unchanged}
        >
          {t('vw.retentionSave')}
        </Button>
        <RetentionFields
          id={id}
          pending={pending}
          publisherManaged={publisherManaged}
          limited={limited}
          count={count}
          valid={valid}
          onEdit={editDraft}
        />
        <div
          role="status"
          data-retention-saved={saved || undefined}
          className="text-sm"
        >
          {!preview && retentionSaveStatus(pending, error, saved, t)}
        </div>
      </form>
      <RetentionConfirmation
        preview={preview}
        pending={pending}
        error={error}
        publisherManaged={publisherManaged}
        busy={busy}
        saveButton={saveButton}
        changeButton={changeButton}
        onPreviewChange={setPreview}
        onSave={save}
      />
    </>
  )
}

function RetentionConfirmation({
  preview,
  pending,
  error,
  publisherManaged,
  busy,
  saveButton,
  changeButton,
  onPreviewChange,
  onSave,
}: {
  preview: Preview | null
  pending: boolean
  error: 'failed' | 'changed' | null
  publisherManaged?: boolean
  busy: RefObject<symbol | null>
  saveButton: RefObject<HTMLButtonElement | null>
  changeButton: RefObject<HTMLButtonElement | null>
  onPreviewChange: (preview: Preview | null) => void
  onSave: (preview: Preview) => Promise<void>
}) {
  const { t } = useT()
  return (
    <AlertDialog
      open={preview !== null}
      onOpenChange={(open) => {
        if (!open && !busy.current) onPreviewChange(null)
      }}
    >
      <AlertDialogContent
        onCloseAutoFocus={(event) => {
          event.preventDefault()
          const target = saveButton.current?.disabled
            ? changeButton.current
            : saveButton.current
          target?.focus()
        }}
      >
        <AlertDialogHeader>
          <AlertDialogTitle>
            {t(
              publisherManaged
                ? 'vw.retentionManagedConfirmTitle'
                : 'vw.retentionConfirmTitle',
            )}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {t(
              publisherManaged
                ? preview?.count === 1
                  ? 'vw.retentionManagedConfirmOne'
                  : 'vw.retentionManagedConfirm'
                : preview?.count === 1
                  ? 'vw.retentionConfirmOne'
                  : 'vw.retentionConfirm',
              { count: preview?.count ?? 0 },
            )}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div role="status" className="text-sm">
          {pending ? t('vw.retentionSaving') : null}
        </div>
        {error ? (
          <p role="alert" className="text-destructive text-sm">
            {t(
              error === 'changed'
                ? 'vw.retentionChanged'
                : 'vw.retentionFailed',
            )}
          </p>
        ) : null}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>
            {t('confirm.cancel')}
          </AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            disabled={pending}
            onClick={(event) => {
              event.preventDefault()
              if (preview) void onSave(preview)
            }}
          >
            {t('vw.retentionConfirmSave')}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

function retentionProposal(limited: boolean, count: string) {
  const proposed = limited ? Number(count) : null
  // Match the contract's nullable z.number().int().min(1) without a runtime
  // package import: Zod integer validation also rejects unsafe integers.
  const valid =
    proposed === null ||
    (count.trim() !== '' && Number.isSafeInteger(proposed) && proposed >= 1)
  return { proposed, valid }
}

function RetentionFields({
  id,
  pending,
  publisherManaged,
  limited,
  count,
  valid,
  onEdit,
}: {
  id: string
  pending: boolean
  publisherManaged?: boolean
  limited: boolean
  count: string
  valid: boolean
  onEdit: (draft: { limited: boolean; count: string }) => void
}) {
  const { t } = useT()
  return (
    <div className="flex flex-col gap-2">
      <p id={`${id}-title`} className="text-sm font-medium">
        {t('vw.retentionTitle')}
      </p>
      {publisherManaged ? (
        <p id={`${id}-protection`} className="text-muted-foreground text-sm">
          {t('vw.retentionManagedProtection')}
        </p>
      ) : null}
      <RadioGroup
        aria-labelledby={`${id}-title`}
        aria-describedby={publisherManaged ? `${id}-protection` : undefined}
        value={limited ? 'limited' : 'all'}
        onValueChange={(value) =>
          onEdit({ limited: value === 'limited', count })
        }
        disabled={pending}
      >
        <label className="flex items-center gap-2 text-sm">
          <RadioGroupItem value="all" data-retention-all />
          {t('vw.retentionAll')}
        </label>
        <label className="flex items-center gap-2 text-sm">
          <RadioGroupItem value="limited" data-retention-limited />
          {t(
            publisherManaged
              ? 'vw.retentionManagedLimited'
              : 'vw.retentionLimited',
          )}
        </label>
      </RadioGroup>
      {limited ? (
        <div className="flex flex-col gap-1">
          <label htmlFor={`${id}-count`} className="text-sm">
            {t(
              publisherManaged
                ? 'vw.retentionManagedCount'
                : 'vw.retentionCount',
            )}
          </label>
          <Input
            id={`${id}-count`}
            type="number"
            disabled={pending}
            min="1"
            step="1"
            required
            value={count}
            aria-invalid={!valid}
            aria-describedby={
              [
                publisherManaged ? `${id}-protection` : '',
                !valid ? `${id}-error` : '',
              ]
                .filter(Boolean)
                .join(' ') || undefined
            }
            onChange={(event) => onEdit({ limited, count: event.target.value })}
          />
          {!valid ? (
            <p id={`${id}-error`} className="text-destructive text-sm">
              {t('vw.retentionInvalid')}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

function retentionSaveStatus(
  pending: boolean,
  error: 'failed' | 'changed' | null,
  saved: boolean,
  t: ReturnType<typeof useT>['t'],
) {
  if (pending) return t('vw.retentionSaving')
  if (error)
    return t(error === 'changed' ? 'vw.retentionChanged' : 'vw.retentionFailed')
  return saved ? t('vw.retentionSaved') : null
}
