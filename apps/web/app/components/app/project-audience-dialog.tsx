import { useReducer, useState } from 'react'
import { useRevalidator } from 'react-router'
import { toast } from 'sonner'
import {
  GrantEditorHeader,
  GrantEditorInput,
  GrantEditorList,
  GrantEditorRow,
  GrantEditorSection,
} from '~/components/app/grant-editor-section'
import {
  countRestoredEntries,
  createGrantEditorState,
  deriveGrantRowStatus,
  getGrantEditorView,
  grantEditorReducer,
  hasGrantEditorChanges,
  remainingGrantSlotsAfterRestore,
} from '~/components/app/grant-editor-state'
import {
  AudienceEntryMeta,
  AudienceImpactNotes,
  type AudienceRoleContextValue,
  AudienceRoleProvider,
  RoleSelect,
} from '~/components/app/project-audience-roles'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '~/components/ui/dialog'
import { Button } from '~/components/ui/button'
import { useT } from '~/hooks/use-t'
import { readErrorTag } from '~/lib/api-errors'
import {
  isExternalEmail,
  MAX_GRANT_EMAILS,
  parseGrantEmails,
} from '~/lib/grant-emails'
import type { ProjectShareRole } from '~/lib/shareable-types'
import type { ProjectShareDefault } from '~/services/projects.server'

type ShareDefaultUser = ProjectShareDefault['user']

interface ProjectAudienceDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  projectId: string
  canEdit: boolean
  externalPostingEnabled: boolean
  viewerEmail: string
  workspaceHd: string | null
  defaults: ReadonlyArray<ProjectShareDefault>
  // 関係者を継承する成果物 (visibility='project') の件数。保存時の影響注記に使う。
  artifactCount: number
}

function useProjectAudienceEditor({
  open,
  onOpenChange,
  projectId,
  canEdit,
  externalPostingEnabled,
  viewerEmail,
  workspaceHd,
  defaults,
}: ProjectAudienceDialogProps) {
  const { t } = useT()
  const revalidator = useRevalidator()
  const endpoint = `/api/projects/${encodeURIComponent(projectId)}/share-defaults`
  const [state, dispatch] = useReducer(
    grantEditorReducer,
    createGrantEditorState(open),
  )
  const [addRole, setAddRole] = useState<ProjectShareRole>('contributor')
  const [pendingAddRoles, setPendingAddRoles] = useState<
    Record<string, ProjectShareRole>
  >({})
  const [roleChanges, setRoleChanges] = useState<
    Record<string, ProjectShareRole>
  >({})

  if (state.prevOpen !== open) {
    dispatch({ type: 'sync-open', open })
    if (open) {
      setAddRole('contributor')
      setPendingAddRoles({})
      setRoleChanges({})
    }
  }

  const view = getGrantEditorView(state, defaults)
  const showRoleUi = externalPostingEnabled
  const hasChanges =
    hasGrantEditorChanges(state, view) || Object.keys(roleChanges).length > 0
  const externalActiveCount =
    defaults.filter(
      (entry) => !state.pendingRemoves.has(entry.email) && entry.isExternal,
    ).length +
    view.pendingAddEntries.filter((entry) =>
      isExternalEmail(entry.email, workspaceHd),
    ).length

  const getDefaultRole = (email: string): ProjectShareRole =>
    defaults.find((entry) => entry.email === email)?.role ?? 'viewer'

  const commitInput = async (value = state.input) => {
    const emails = parseGrantEmails(value, viewerEmail)
    dispatch({ type: 'clear-input' })
    if (emails.length === 0) return

    const restoredCount = countRestoredEntries(
      emails,
      state.pendingRemoves,
      view.initialEntries,
    )
    dispatch({ type: 'restore-entries', emails })

    const targets = emails.filter(
      (email) =>
        !view.initialEntries.some((entry) => entry.email === email) &&
        !state.pendingAdds.some((entry) => entry.email === email),
    )
    if (targets.length === 0) return

    const remaining = remainingGrantSlotsAfterRestore(
      view.activeCount,
      restoredCount,
    )
    const limited = targets.slice(0, remaining)
    if (limited.length < targets.length) {
      toast.error(
        t('visibilityDialog.grants.limitReached', { limit: MAX_GRANT_EMAILS }),
      )
    }
    if (limited.length === 0) return

    if (showRoleUi) {
      setPendingAddRoles((prev) => {
        const next = { ...prev }
        for (const email of limited) next[email] = addRole
        return next
      })
    }

    dispatch({ type: 'add-pending-entries', emails: limited })

    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'lookup', emails: limited }),
      })
      if (!res.ok) return
      const body = (await res.json()) as {
        entries: { email: string; user: ShareDefaultUser }[]
      }
      dispatch({ type: 'resolve-pending-entries', entries: body.entries })
    } catch {
      // lookup 失敗時は user:null のまま残す (保存後に loader が解決する)。
    }
  }

  const removeRow = (email: string) => {
    if (state.pendingAdds.some((entry) => entry.email === email)) {
      dispatch({ type: 'remove-pending-entry', email })
      setPendingAddRoles((prev) => {
        const next = { ...prev }
        delete next[email]
        return next
      })
      return
    }
    dispatch({ type: 'toggle-entry-removal', email })
  }

  const save = async () => {
    dispatch({ type: 'set-saving', saving: true })
    try {
      const filteredRoleChanges: { email: string; role: ProjectShareRole }[] =
        []
      for (const [email, role] of Object.entries(roleChanges)) {
        if (
          defaults.some((entry) => entry.email === email) &&
          !state.pendingRemoves.has(email)
        ) {
          filteredRoleChanges.push({ email, role })
        }
      }

      const body = showRoleUi
        ? {
            ...(view.pendingAddEmails.length > 0
              ? {
                  addEntries: view.pendingAddEmails.map((email) => ({
                    email,
                    role: pendingAddRoles[email] ?? addRole,
                  })),
                }
              : {}),
            ...(filteredRoleChanges.length > 0
              ? { roleChanges: filteredRoleChanges }
              : {}),
            ...(state.pendingRemoves.size > 0
              ? { removeEmails: Array.from(state.pendingRemoves) }
              : {}),
          }
        : {
            ...(view.pendingAddEmails.length > 0
              ? { addEmails: view.pendingAddEmails }
              : {}),
            ...(state.pendingRemoves.size > 0
              ? { removeEmails: Array.from(state.pendingRemoves) }
              : {}),
          }

      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (res.status === 401 || res.status === 403) {
        toast.error(t('reauth.body'))
        return
      }
      if (!res.ok) {
        const code = await readErrorTag(res)
        toast.error(
          code === 'too-many-grants'
            ? t('visibilityDialog.grants.limitReached', {
                limit: MAX_GRANT_EMAILS,
              })
            : t('visibilityDialog.error.storageFailed'),
        )
        return
      }
      toast.success(t('visibilityDialog.success'))
      revalidator.revalidate()
      onOpenChange(false)
    } catch {
      toast.error(t('visibilityDialog.error.storageFailed'))
    } finally {
      dispatch({ type: 'set-saving', saving: false })
    }
  }

  const handleSave = () => {
    if (!hasChanges) {
      onOpenChange(false)
      return
    }
    void save()
  }

  const roleContext: AudienceRoleContextValue = {
    canEdit,
    saving: state.saving,
    workspaceHd,
    pendingAddEmails: view.pendingAddEmails,
    pendingAddRoles,
    roleChanges,
    addRole,
    setPendingAddRoles,
    setRoleChanges,
    getDefaultRole,
  }

  return {
    input: state.input,
    saving: state.saving,
    pendingRemoves: state.pendingRemoves,
    pendingAddCount: state.pendingAdds.length,
    pendingRemoveCount: state.pendingRemoves.size,
    view,
    hasChanges,
    externalActiveCount,
    showRoleUi,
    addRole,
    setAddRole,
    roleContext,
    setInput: (value: string) => dispatch({ type: 'set-input', value }),
    commitInput,
    removeRow,
    handleSave,
  }
}

export function ProjectAudienceDialog(props: ProjectAudienceDialogProps) {
  const { open, onOpenChange, canEdit, artifactCount } = props
  const { t } = useT()
  const editor = useProjectAudienceEditor(props)
  const { showRoleUi, view } = editor

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[var(--breakpoint-phone)] sm:max-w-[var(--breakpoint-phone)]">
        <DialogHeader>
          <DialogTitle>{t('projectShareDefaults.title')}</DialogTitle>
          <DialogDescription>
            {t('projectShareDefaults.description')}
          </DialogDescription>
        </DialogHeader>

        <AudienceRoleProvider value={editor.roleContext}>
          <GrantEditorSection ariaLabel={t('projectShareDefaults.title')}>
            {canEdit ? (
              <GrantEditorInput
                input={editor.input}
                saving={editor.saving}
                limitReached={view.limitReached}
                onInputChange={editor.setInput}
                onCommitInput={() => void editor.commitInput()}
              >
                {showRoleUi ? (
                  <RoleSelect
                    value={editor.addRole}
                    disabled={editor.saving}
                    onChange={editor.setAddRole}
                  />
                ) : null}
              </GrantEditorInput>
            ) : null}

            <GrantEditorHeader
              title={t('projectShareDefaults.current')}
              count={t('projectShareDefaults.count', {
                count: view.activeCount,
              })}
            />

            {view.visibleEntries.length === 0 ? (
              <p className="text-faint">{t('projectShareDefaults.empty')}</p>
            ) : (
              <GrantEditorList>
                {view.visibleEntries.map((entry) => (
                  <GrantEditorRow
                    key={entry.email}
                    entry={entry}
                    saving={editor.saving}
                    canEdit={canEdit}
                    status={deriveGrantRowStatus(
                      entry.email,
                      view.pendingAddEmails,
                      editor.pendingRemoves,
                    )}
                    showRole={showRoleUi}
                    onRemove={editor.removeRow}
                  >
                    {showRoleUi ? <AudienceEntryMeta entry={entry} /> : null}
                  </GrantEditorRow>
                ))}
              </GrantEditorList>
            )}

            <AudienceImpactNotes
              externalActiveCount={editor.externalActiveCount}
              artifactCount={artifactCount}
              pendingAddCount={editor.pendingAddCount}
              pendingRemoveCount={editor.pendingRemoveCount}
            />
          </GrantEditorSection>
        </AudienceRoleProvider>

        <AudienceDialogFooter
          canEdit={canEdit}
          saving={editor.saving}
          hasChanges={editor.hasChanges}
          onClose={() => onOpenChange(false)}
          onSave={editor.handleSave}
        />
      </DialogContent>
    </Dialog>
  )
}

function AudienceDialogFooter({
  canEdit,
  saving,
  hasChanges,
  onClose,
  onSave,
}: {
  canEdit: boolean
  saving: boolean
  hasChanges: boolean
  onClose: () => void
  onSave: () => void
}) {
  const { t } = useT()
  if (!canEdit) {
    return (
      <DialogFooter>
        <Button type="button" size="sm" onClick={onClose}>
          {t('visibilityDialog.close')}
        </Button>
      </DialogFooter>
    )
  }
  return (
    <DialogFooter>
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={onClose}
        disabled={saving}
      >
        {t('visibilityDialog.cancel')}
      </Button>
      <Button type="button" size="sm" onClick={onSave} disabled={saving}>
        {hasChanges ? t('visibilityDialog.save') : t('visibilityDialog.close')}
      </Button>
    </DialogFooter>
  )
}
