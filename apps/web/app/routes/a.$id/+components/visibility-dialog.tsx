import { useReducer } from 'react'
import { useRevalidator } from 'react-router'
import { toast } from 'sonner'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '~/components/ui/dialog'
import { Button } from '~/components/ui/button'
import { Input } from '~/components/ui/input'
import { useCopyState } from '~/hooks/use-copy-state'
import { useT } from '~/hooks/use-t'
import { MAX_GRANT_EMAILS, parseGrantEmails } from '~/lib/grant-emails'
import {
  addDaysToLocalDate,
  clampLocalDateToMaximum,
  localDateEndAsUtc,
  maximumSelectableLocalDate,
  toLocalDateInputValue,
} from '~/lib/link-expiry-date'
import {
  type EditableVisibility,
  type ProjectBaseVisibility,
  type Visibility,
} from '~/lib/shareable-types'
import type { GrantEntry } from '~/services/shareables.server'
import { VisibilitySelect } from '~/components/app/visibility-select'
import {
  type VisibilityDialogOwner,
  VisibilityGrantsSection,
} from './visibility-grants-section'
import {
  countRestoredEntries,
  remainingGrantSlotsAfterRestore,
} from '~/components/app/grant-editor-state'
import {
  createVisibilityDialogState,
  getVisibilityDialogGrantView,
  hasVisibilityDialogChanges,
  visibilityDialogReducer,
} from './visibility-dialog-state'
import { dialogNoteWarnClassName } from './dialog-note-styles'

interface VisibilityDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  shareableId: string
  currentVisibility: Visibility
  availableVisibilities: ReadonlyArray<EditableVisibility>
  workspaceHd: string | null
  projectBaseVisibility: ProjectBaseVisibility | null
  owner: VisibilityDialogOwner
  grants: ReadonlyArray<GrantEntry>
  linkSharingAvailable: boolean
  linkExpiresAt: string | null
  linkExpiryDefaultDays: number | null
  linkExpiryMaxDays: number | null
  linkExpired: boolean
}

export function VisibilityDialog({
  open,
  onOpenChange,
  shareableId,
  currentVisibility,
  availableVisibilities,
  workspaceHd,
  projectBaseVisibility,
  owner,
  grants: initialGrants,
  linkSharingAvailable,
  linkExpiresAt,
  linkExpiryDefaultDays,
  linkExpiryMaxDays,
  linkExpired,
}: VisibilityDialogProps) {
  const { t } = useT()
  const revalidator = useRevalidator()
  const saveEndpoint = `/api/shareables/${encodeURIComponent(shareableId)}/save`
  const lookupEndpoint = `/api/shareables/${encodeURIComponent(shareableId)}/grants/lookup`
  const currentEditableVisibility = currentVisibility
  const currentLinkExpiryDate = toLocalDateInputValue(linkExpiresAt)
  const minimumLinkExpiryDate = addDaysToLocalDate(0)
  const maximumLinkExpiryDate =
    linkExpiryMaxDays === null
      ? undefined
      : maximumSelectableLocalDate(linkExpiryMaxDays)
  const requestedDefaultLinkExpiryDate = linkExpiryDefaultDays
    ? addDaysToLocalDate(linkExpiryDefaultDays)
    : null
  const defaultLinkExpiryDate = clampLocalDateToMaximum(
    requestedDefaultLinkExpiryDate,
    maximumLinkExpiryDate,
  )
  const [state, dispatch] = useReducer(
    visibilityDialogReducer,
    createVisibilityDialogState(currentEditableVisibility, open, {
      linkExpiryDate: currentLinkExpiryDate,
      linkExpiryUnlimited:
        currentEditableVisibility === 'link'
          ? currentLinkExpiryDate === null
          : linkExpiryDefaultDays === null,
    }),
  )

  if (state.prevOpen !== open) {
    dispatch({
      type: 'sync-open',
      open,
      currentVisibility: currentEditableVisibility,
      linkExpiryDate: currentLinkExpiryDate,
      linkExpiryUnlimited:
        currentEditableVisibility === 'link'
          ? currentLinkExpiryDate === null
          : linkExpiryDefaultDays === null,
    })
  }

  const grantView = getVisibilityDialogGrantView(
    state,
    initialGrants,
    owner.email,
  )
  const hasPendingChanges = hasVisibilityDialogChanges(
    state,
    grantView,
    currentVisibility,
    state.linkExpiryTouched,
  )
  const showsGrants =
    state.selected === 'private' ||
    state.selected === 'workspace' ||
    state.selected === 'project'

  const commitGrantInput = async (value = state.grants.input) => {
    const emails = parseGrantEmails(value, owner.email)
    dispatch({ type: 'clear-grant-input' })
    if (emails.length === 0) return

    const restoredGrantCount = countRestoredEntries(
      emails,
      state.grants.pendingRemoves,
      grantView.initialEntries,
    )
    dispatch({ type: 'restore-grants', emails })
    const targets = emails.filter(
      (email) =>
        !grantView.initialEntries.some((entry) => entry.email === email) &&
        !state.grants.pendingAdds.some((entry) => entry.email === email),
    )
    if (targets.length === 0) return
    const remainingSlots = remainingGrantSlotsAfterRestore(
      grantView.activeCount,
      restoredGrantCount,
    )
    const limitedTargets = targets.slice(0, remainingSlots)
    if (limitedTargets.length < targets.length) {
      toast.error(
        t('visibilityDialog.grants.limitReached', {
          limit: MAX_GRANT_EMAILS,
        }),
      )
    }
    if (limitedTargets.length === 0) return
    dispatch({ type: 'add-pending-grants', emails: limitedTargets })
    try {
      const res = await fetch(lookupEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ emails: limitedTargets }),
      })
      if (!res.ok) return
      const body = (await res.json()) as {
        entries: { email: string; user: GrantEntry['user'] }[]
      }
      dispatch({ type: 'resolve-pending-grants', entries: body.entries })
    } catch {
      // lookup 失敗時は entry をそのまま残す (user:null fallback)
    }
  }

  const removeGrant = (email: string) => {
    if (state.grants.pendingAdds.some((entry) => entry.email === email)) {
      dispatch({ type: 'remove-pending-grant', email })
      return
    }
    dispatch({ type: 'toggle-grant-removal', email })
  }

  const save = async () => {
    dispatch({ type: 'set-saving', saving: true })
    try {
      const res = await fetch(saveEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...(state.selected !== currentVisibility
            ? { visibility: state.selected }
            : {}),
          ...(state.selected === 'link' && state.linkExpiryTouched
            ? {
                link_expires_at: state.linkExpiryUnlimited
                  ? null
                  : localDateEndAsUtc(
                      state.linkExpiryDate ?? defaultLinkExpiryDate,
                    ),
              }
            : {}),
          ...(grantView.pendingAddEmails.length > 0
            ? { addEmails: grantView.pendingAddEmails }
            : {}),
          ...(state.grants.pendingRemoves.size > 0
            ? { removeEmails: Array.from(state.grants.pendingRemoves) }
            : {}),
        }),
      })
      if (res.status === 401 || res.status === 403) {
        toast.error(t('reauth.body'))
        return
      }
      if (!res.ok) {
        toast.error(await readSaveError(res, t))
        return
      }

      toast.success(t('visibilityDialog.success'))
      revalidator.revalidate()
      onOpenChange(false)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to save')
    } finally {
      dispatch({ type: 'set-saving', saving: false })
    }
  }

  const handleSave = () => {
    if (!hasPendingChanges) {
      onOpenChange(false)
      return
    }
    void save()
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent aria-modal="true">
        <DialogHeader>
          <DialogTitle>{t('visibilityDialog.title')}</DialogTitle>
          <DialogDescription>{t('upload.visibility.label')}</DialogDescription>
        </DialogHeader>

        <VisibilitySelect
          selected={state.selected}
          availableVisibilities={availableVisibilities}
          label={(v) => t(`upload.visibility.${v}`)}
          description={(v) =>
            t(`upload.visibility.${v}.sub`, { hd: workspaceHd ?? '—' })
          }
          onSelect={(value) => dispatch({ type: 'select', value })}
        />
        {showsGrants ? (
          <VisibilityGrantsSection
            shareableId={shareableId}
            selected={state.selected}
            workspaceHd={workspaceHd}
            owner={owner}
            grantInput={state.grants.input}
            saving={state.grants.saving}
            grantLimitReached={grantView.limitReached}
            activeGrantCount={grantView.activeCount}
            visibleGrants={grantView.visibleEntries}
            pendingAddEmails={grantView.pendingAddEmails}
            pendingRemoves={state.grants.pendingRemoves}
            onGrantInputChange={(value) =>
              dispatch({ type: 'set-grant-input', value })
            }
            onCommitGrantInput={(value) => void commitGrantInput(value)}
            onRemoveGrant={removeGrant}
          />
        ) : null}
        {state.selected === 'workspace' && workspaceHd ? (
          <p className="text-muted-foreground">
            {t('visibilityDialog.grants.note.workspace', {
              hd: workspaceHd,
              count: grantView.activeCount,
            })}
          </p>
        ) : null}
        {state.selected === 'project' ? (
          <p className="text-muted-foreground">
            {t(
              projectBaseVisibility === 'workspace'
                ? 'visibilityDialog.grants.note.projectWorkspace'
                : 'visibilityDialog.grants.note.projectPrivate',
            )}
          </p>
        ) : null}
        {state.selected === 'link' ? (
          <LinkVisibilitySection
            shareableId={shareableId}
            available={linkSharingAvailable}
            expired={linkExpired}
            expiryDate={state.linkExpiryDate ?? defaultLinkExpiryDate}
            minimumDate={minimumLinkExpiryDate}
            maximumDate={maximumLinkExpiryDate}
            unlimited={state.linkExpiryUnlimited}
            showUnlimited={linkExpiryMaxDays === null}
            onExpiryDateChange={(value) =>
              dispatch({ type: 'set-link-expiry-date', value })
            }
            onUnlimitedChange={(value) =>
              dispatch({ type: 'set-link-expiry-unlimited', value })
            }
            onRepublish={() => {
              if (defaultLinkExpiryDate) {
                dispatch({
                  type: 'set-link-expiry-date',
                  value: defaultLinkExpiryDate,
                })
              } else {
                dispatch({ type: 'set-link-expiry-unlimited', value: true })
              }
            }}
          />
        ) : null}

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => onOpenChange(false)}
            disabled={state.grants.saving}
          >
            {t('visibilityDialog.cancel')}
          </Button>
          <Button
            type="button"
            size="sm"
            onClick={handleSave}
            disabled={
              state.grants.saving ||
              (hasPendingChanges &&
                state.selected === 'link' &&
                !linkSharingAvailable)
            }
          >
            {hasPendingChanges
              ? t('visibilityDialog.save')
              : t('visibilityDialog.close')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function LinkVisibilitySection({
  shareableId,
  available,
  expired,
  expiryDate,
  minimumDate,
  maximumDate,
  unlimited,
  showUnlimited,
  onExpiryDateChange,
  onUnlimitedChange,
  onRepublish,
}: {
  shareableId: string
  available: boolean
  expired: boolean
  expiryDate: string | null
  minimumDate: string
  maximumDate?: string
  unlimited: boolean
  showUnlimited: boolean
  onExpiryDateChange: (value: string) => void
  onUnlimitedChange: (value: boolean) => void
  onRepublish: () => void
}) {
  const { t } = useT()
  const url = `${location.origin}/a/${shareableId}`
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
      {expired ? (
        <div className="border-warning/40 bg-warning-soft flex flex-col gap-2 rounded-[var(--r-md)] border p-3 text-sm">
          <span>{t('visibilityDialog.link.expired')}</span>
          {available ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={onRepublish}
            >
              {t('visibilityDialog.link.republish')}
            </Button>
          ) : null}
        </div>
      ) : null}
      <label className="flex flex-col gap-1 text-sm">
        <span className="font-medium">{t('visibilityDialog.link.expiry')}</span>
        <Input
          type="date"
          value={unlimited ? '' : (expiryDate ?? '')}
          min={minimumDate}
          max={maximumDate}
          disabled={unlimited || !available}
          onChange={(event) => onExpiryDateChange(event.currentTarget.value)}
        />
      </label>
      {showUnlimited ? (
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={unlimited}
            disabled={!available}
            onChange={(event) => onUnlimitedChange(event.currentTarget.checked)}
          />
          {t('visibilityDialog.link.unlimited')}
        </label>
      ) : null}
      <div className="border-border bg-muted flex items-center gap-2 rounded-[var(--r-md)] border p-2">
        <span className="text-muted-foreground min-w-0 flex-1 overflow-hidden text-sm text-ellipsis whitespace-nowrap select-all">
          {url}
        </span>
        <Button type="button" size="sm" onClick={copy}>
          {state === 'copied'
            ? t('visibilityDialog.link.copied')
            : t('visibilityDialog.link.copyButton')}
        </Button>
      </div>
    </>
  )
}

async function readSaveError(
  res: Response,
  t: ReturnType<typeof useT>['t'],
): Promise<string> {
  try {
    const body = (await res.json()) as {
      error?: { code?: string; message?: string } | string
    }
    if (typeof body.error === 'string') return body.error
    switch (body.error?.code) {
      case 'commit-failed':
        return t('visibilityDialog.error.storageFailed')
      case 'workspace-unavailable':
        return t('visibilityDialog.error.workspaceUnavailable')
      case 'too-many-grants':
        return t('visibilityDialog.grants.limitReached', {
          limit: MAX_GRANT_EMAILS,
        })
      case 'link-sharing-plan-required':
        return t('visibilityDialog.link.planRequired')
      case 'link-sharing-disabled':
        return t('visibilityDialog.link.unavailable')
      case 'link-expiry-invalid':
        return t('visibilityDialog.link.expiryInvalid')
    }
    return body.error?.message ?? 'Failed to save'
  } catch {
    return (await res.text()) || 'Failed to save'
  }
}
