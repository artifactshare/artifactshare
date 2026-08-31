import { AuthorAvatar } from '~/components/app/author-avatar'
import {
  GrantEditorHeader,
  GrantEditorInput,
  GrantEditorList,
  GrantEditorRow,
  GrantEditorSection,
} from '~/components/app/grant-editor-section'
import {
  grantsRowBodyClassName,
  grantsRowClassName,
  grantsRowSubClassName,
  grantsRowTitleClassName,
  grantsYouMarkClassName,
} from '~/components/app/grant-editor-styles'
import {
  deriveGrantRowStatus,
  type GrantEditorEntry,
} from '~/components/app/grant-editor-state'
import { useT } from '~/hooks/use-t'
import { cn } from '~/lib/utils'
import type { EditableVisibility } from '~/lib/shareable-types'

export interface VisibilityDialogOwner {
  id: string
  email: string | null
  name: string | null
  image: string | null
  initial: string
}

interface VisibilityGrantsSectionProps {
  selected: EditableVisibility
  workspaceHd: string | null
  owner: VisibilityDialogOwner
  grantInput: string
  saving: boolean
  grantLimitReached: boolean
  activeGrantCount: number
  visibleGrants: ReadonlyArray<GrantEditorEntry>
  pendingAddEmails: ReadonlyArray<string>
  pendingRemoves: ReadonlySet<string>
  shareableId: string
  onGrantInputChange: (value: string) => void
  onCommitGrantInput: (value?: string) => void
  onRemoveGrant: (email: string) => void
}

export function VisibilityGrantsSection({
  selected,
  workspaceHd,
  owner,
  grantInput,
  saving,
  grantLimitReached,
  activeGrantCount,
  visibleGrants,
  pendingAddEmails,
  pendingRemoves,
  shareableId,
  onGrantInputChange,
  onCommitGrantInput,
  onRemoveGrant,
}: VisibilityGrantsSectionProps) {
  const { t } = useT()
  const headerTitle =
    selected === 'workspace'
      ? t('visibilityDialog.grants.header.title.workspace', {
          hd: workspaceHd ?? '',
        })
      : selected === 'project'
        ? t('visibilityDialog.grants.header.title.project')
        : t('visibilityDialog.grants.header.title.private')
  const headerCount =
    selected === 'workspace'
      ? t('visibilityDialog.grants.header.count.workspace', {
          count: activeGrantCount,
        })
      : selected === 'project'
        ? t('visibilityDialog.grants.header.count.project', {
            count: activeGrantCount,
          })
        : t('visibilityDialog.grants.header.count.private', {
            count: activeGrantCount + 1,
          })

  return (
    <GrantEditorSection ariaLabel={t('visibilityDialog.grants.sectionAria')}>
      <GrantEditorInput
        input={grantInput}
        saving={saving}
        limitReached={grantLimitReached}
        suggestionContext={{ kind: 'shareable', id: shareableId }}
        excludedEmails={pendingAddEmails}
        ownerEmail={owner.email}
        onInputChange={onGrantInputChange}
        onCommitInput={onCommitGrantInput}
      />

      <GrantEditorHeader title={headerTitle} count={headerCount} />

      <GrantEditorList>
        {selected === 'private' ? (
          <li className={grantsRowClassName}>
            <AuthorAvatar
              id={owner.id}
              image={owner.image}
              initial={owner.initial}
            />
            <div className={grantsRowBodyClassName}>
              <div className={cn(grantsRowTitleClassName, 'font-medium')}>
                {owner.name ?? owner.email ?? owner.id}
                <span className={grantsYouMarkClassName}>
                  {t('visibilityDialog.grants.you')}
                </span>
              </div>
              <div
                className={cn(grantsRowSubClassName, 'text-muted-foreground')}
              >
                {owner.email ?? owner.id} · {t('visibilityDialog.grants.owner')}
              </div>
            </div>
          </li>
        ) : null}
        {visibleGrants.map((entry) => (
          <GrantEditorRow
            key={entry.email}
            entry={entry}
            saving={saving}
            canEdit={true}
            status={deriveGrantRowStatus(
              entry.email,
              pendingAddEmails,
              pendingRemoves,
            )}
            onRemove={onRemoveGrant}
          />
        ))}
      </GrantEditorList>
    </GrantEditorSection>
  )
}
