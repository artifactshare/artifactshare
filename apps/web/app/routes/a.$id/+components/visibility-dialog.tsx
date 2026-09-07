import { useReducer } from 'react'
import { useRevalidator } from 'react-router'
import { toast } from 'sonner'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '~/components/ui/dialog'
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
  hasLinkExpiryChanges,
  hasVisibilityDialogChanges,
  visibilityDialogReducer,
} from './visibility-dialog-state'
import {
  LinkVisibilitySection,
  VisibilityDialogActions,
} from './visibility-dialog-sections'

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
  linkSuspended?: boolean
}

export function VisibilityDialog(props: VisibilityDialogProps) {
  return <ScopedVisibilityDialog key={props.shareableId} {...props} />
}

function ScopedVisibilityDialog({
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
  linkSuspended = false,
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
  const initialLinkExpiryDate = currentLinkExpiryDate ?? defaultLinkExpiryDate
  const initialLinkExpiryUnlimited =
    currentEditableVisibility === 'link'
      ? currentLinkExpiryDate === null
      : linkExpiryDefaultDays === null
  const [state, dispatch] = useReducer(
    visibilityDialogReducer,
    createVisibilityDialogState(currentEditableVisibility, open, {
      linkExpiryDate: initialLinkExpiryDate,
      linkExpiryUnlimited: initialLinkExpiryUnlimited,
    }),
  )
  if (state.prevOpen !== open) {
    dispatch({
      type: 'sync-open',
      open,
      currentVisibility: currentEditableVisibility,
      linkExpiryDate: initialLinkExpiryDate,
      linkExpiryUnlimited: initialLinkExpiryUnlimited,
    })
  }

  const grantView = getVisibilityDialogGrantView(
    state,
    initialGrants,
    owner.email,
  )
  const savedVisibility = state.savedLinkVisible ? 'link' : currentVisibility
  const linkExpiryChanged = hasLinkExpiryChanges(state, {
    date: initialLinkExpiryUnlimited ? null : initialLinkExpiryDate,
    unlimited: initialLinkExpiryUnlimited,
  })
  const finiteLinkExpiryMissing =
    state.selected === 'link' &&
    !state.linkExpiryUnlimited &&
    !state.linkExpiryDate
  const hasPendingChanges = hasVisibilityDialogChanges(
    state,
    grantView,
    savedVisibility,
    linkExpiryChanged,
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
          ...(state.selected !== savedVisibility
            ? { visibility: state.selected }
            : {}),
          ...(linkExpiryChanged
            ? {
                link_expires_at: state.linkExpiryUnlimited
                  ? null
                  : localDateEndAsUtc(state.linkExpiryDate),
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

      await revalidator.revalidate()
      toast.success(t('visibilityDialog.success'))
      dispatch({ type: 'save-succeeded', visibility: state.selected })
      if (state.selected !== 'link') onOpenChange(false)
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

  const handleOpenChange = (nextOpen: boolean) => {
    if (!state.grants.saving) onOpenChange(nextOpen)
  }
  const primaryLabelKey = hasPendingChanges
    ? 'visibilityDialog.save'
    : 'visibilityDialog.close'

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent aria-modal="true" showCloseButton={!state.grants.saving}>
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
          disabled={state.grants.saving}
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
            suspended={linkSuspended}
            saving={state.grants.saving}
            expiryDate={state.linkExpiryDate}
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
            showActions={currentVisibility === 'link' || state.savedLinkVisible}
          />
        ) : null}

        <VisibilityDialogActions
          hasPendingChanges={hasPendingChanges}
          saving={state.grants.saving}
          saveDisabled={
            state.selected === 'link' &&
            (!linkSharingAvailable || finiteLinkExpiryMissing)
          }
          onCancel={() => onOpenChange(false)}
          onSave={handleSave}
          cancelLabel={t('visibilityDialog.cancel')}
          primaryLabel={t(primaryLabelKey)}
        />
      </DialogContent>
    </Dialog>
  )
}

async function readSaveError(
  res: Response,
  t: ReturnType<typeof useT>['t'],
): Promise<string> {
  try {
    const body = (await res.json()) as {
      error?:
        | {
            code?: string
            message?: string
            details?: { limit?: number; retryAfterSeconds?: number }
          }
        | string
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
      case 'link-publish-rate-limited':
        return t('visibilityDialog.link.rateLimited', {
          limit: body.error?.details?.limit ?? 0,
          hours: Math.max(
            1,
            Math.ceil((body.error?.details?.retryAfterSeconds ?? 0) / 3600),
          ),
        })
      case 'link-expiry-invalid':
        return t('visibilityDialog.link.expiryInvalid')
    }
    return body.error?.message ?? 'Failed to save'
  } catch {
    return (await res.text()) || 'Failed to save'
  }
}
