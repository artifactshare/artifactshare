import { useId, useRef, useState } from 'react'
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
}: {
  artifactId: string
  publisherManaged?: boolean
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
  const [pending, setPending] = useState(false)
  const busy = useRef(false)
  const saveButton = useRef<HTMLButtonElement>(null)
  const [error, setError] = useState<'failed' | 'changed' | null>(null)
  const [preview, setPreview] = useState<Preview | null>(null)
  const proposed = limited ? Number(count) : null
  // Match the contract's nullable z.number().int().min(1) without a runtime
  // package import: Zod integer validation also rejects unsafe integers.
  const valid =
    proposed === null ||
    (count.trim() !== '' && Number.isSafeInteger(proposed) && proposed >= 1)
  const unchanged = proposed === retainVersions
  function editDraft(next: { limited: boolean; count: string }) {
    setDraft(next)
    setSaved(false)
    setError(null)
  }
  async function save(confirmed?: Preview) {
    if (busy.current || !valid || unchanged) return
    busy.current = true
    setDraft({ limited, count })
    setPending(true)
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
        if (result.kind !== 'preview') throw new Error('invalid preview')
        if (result.count > 0) {
          setPreview(result)
          if (confirmed) setError('changed')
        } else {
          setPreview(null)
          setError('changed')
        }
        return
      }
      if (!response.ok) throw new Error('save failed')
      const result = (await response.json()) as { kind: string }
      if (result.kind !== 'saved') throw new Error('invalid save response')
      await revalidator.revalidate()
      setDraft(null)
      setPreview(null)
      setSaved(true)
    } catch {
      setError('failed')
    } finally {
      busy.current = false
      setPending(false)
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
          {retainVersions === null
            ? t('vw.retentionSummaryAll')
            : t(
                retainVersions === 1
                  ? publisherManaged
                    ? 'vw.retentionManagedNoteOne'
                    : 'vw.retentionNoteOne'
                  : publisherManaged
                    ? 'vw.retentionManagedNoteOther'
                    : 'vw.retentionNoteOther',
                { count: retainVersions },
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
        <fieldset disabled={pending} className="flex flex-col gap-2">
          <legend className="text-sm font-medium">
            {t('vw.retentionTitle')}
          </legend>
          {publisherManaged ? (
            <p className="text-muted-foreground text-sm">
              {t('vw.retentionManagedProtection')}
            </p>
          ) : null}
          <RadioGroup
            aria-label={t('vw.retentionTitle')}
            value={limited ? 'limited' : 'all'}
            onValueChange={(value) =>
              editDraft({ limited: value === 'limited', count })
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
                min="1"
                step="1"
                required
                value={count}
                aria-invalid={!valid}
                aria-describedby={!valid ? `${id}-error` : undefined}
                onChange={(event) =>
                  editDraft({ limited, count: event.target.value })
                }
              />
              {!valid ? (
                <p id={`${id}-error`} className="text-destructive text-sm">
                  {t('vw.retentionInvalid')}
                </p>
              ) : null}
            </div>
          ) : null}
        </fieldset>
        <Button
          data-retention-save
          ref={saveButton}
          type="submit"
          variant="outline"
          disabled={pending || !valid || unchanged}
        >
          {t('vw.retentionSave')}
        </Button>
        <div
          role="status"
          data-retention-saved={saved || undefined}
          className="text-sm"
        >
          {!preview &&
            (pending
              ? t('vw.retentionSaving')
              : error
                ? t(
                    error === 'changed'
                      ? 'vw.retentionChanged'
                      : 'vw.retentionFailed',
                  )
                : saved
                  ? t('vw.retentionSaved')
                  : null)}
        </div>
      </form>
      <AlertDialog
        open={preview !== null}
        onOpenChange={(open) => {
          if (!open && !busy.current) setPreview(null)
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
            <AlertDialogTitle>{t('vw.retentionConfirmTitle')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t(
                preview?.count === 1
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
                if (preview) void save(preview)
              }}
            >
              {t('vw.retentionConfirmSave')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
