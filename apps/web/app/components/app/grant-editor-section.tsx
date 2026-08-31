import type { ReactNode } from 'react'
import { AuthorAvatar } from '~/components/app/author-avatar'
import { IconButton } from '~/components/app/icon-button'
import { Button } from '~/components/ui/button'
import { useT } from '~/hooks/use-t'
import { MAX_GRANT_EMAILS } from '~/lib/grant-emails'
import { cn } from '~/lib/utils'
import { getOwnerInitial } from '~/lib/user'
import {
  grantsHeaderClassName,
  grantsHeaderCountClassName,
  grantsHeaderTitleClassName,
  grantsInputClassName,
  grantsInputRowClassName,
  grantsLimitClassName,
  grantsListClassName,
  grantsRowBodyClassName,
  grantsRowClassName,
  grantsRowMetaClassName,
  grantsRowStatusClassName,
  grantsRowSubClassName,
  grantsRowTitleClassName,
  grantsSectionClassName,
} from './grant-editor-styles'
import type {
  GrantEditorEntry,
  GrantEditorRowStatus,
} from './grant-editor-state'
import { IconX } from '@tabler/icons-react'
import { RecipientSuggestionInput } from './recipient-suggestion-input'
import type { RecipientSuggestionContext } from '~/lib/recipient-suggestions'
import { parseGrantEmails } from '~/lib/grant-emails'

export function GrantEditorSection({
  ariaLabel,
  children,
}: {
  ariaLabel: string
  children: ReactNode
}) {
  return (
    <section className={grantsSectionClassName} aria-label={ariaLabel}>
      {children}
    </section>
  )
}

interface GrantEditorInputProps {
  input: string
  saving: boolean
  limitReached: boolean
  onInputChange: (value: string) => void
  onCommitInput: (value?: string) => void
  suggestionContext: RecipientSuggestionContext
  excludedEmails: ReadonlyArray<string>
  ownerEmail?: string | null
  // 入力欄の右側に差し込む追加コントロール。
  children?: ReactNode
}

export function GrantEditorInput({
  input,
  saving,
  limitReached,
  onInputChange,
  onCommitInput,
  suggestionContext,
  excludedEmails,
  ownerEmail,
  children,
}: GrantEditorInputProps) {
  const { t } = useT()
  return (
    <>
      <div className={grantsInputRowClassName}>
        <RecipientSuggestionInput
          className={grantsInputClassName}
          value={input}
          disabled={saving || limitReached}
          context={suggestionContext}
          excludedEmails={excludedEmails}
          ownerEmail={ownerEmail}
          onChange={onInputChange}
          onCommit={onCommitInput}
          labels={{
            placeholder: t('visibilityDialog.grants.inputPlaceholder'),
            loading: t('visibilityDialog.grants.suggestions.loading'),
            empty: t('visibilityDialog.grants.suggestions.empty'),
            count: (count) =>
              t('visibilityDialog.grants.suggestions.count', { count }),
          }}
        />
        {children ? (
          <div className="order-first w-full sm:order-none sm:w-auto">
            {children}
          </div>
        ) : null}
        <Button
          type="button"
          variant="outline"
          size="default"
          disabled={
            saving ||
            limitReached ||
            parseGrantEmails(input, ownerEmail).length === 0
          }
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => onCommitInput()}
        >
          {t('visibilityDialog.grants.addButton')}
        </Button>
      </div>

      <p
        className={cn(
          grantsLimitClassName,
          limitReached ? 'text-warning' : 'text-muted-foreground',
        )}
      >
        {limitReached
          ? t('visibilityDialog.grants.limitReached', {
              limit: MAX_GRANT_EMAILS,
            })
          : t('visibilityDialog.grants.limitHelp', {
              limit: MAX_GRANT_EMAILS,
            })}
      </p>
    </>
  )
}

export function GrantEditorHeader({
  title,
  count,
}: {
  title: string
  count: string
}) {
  return (
    <div className={grantsHeaderClassName}>
      <span className={grantsHeaderTitleClassName}>{title}</span>
      <span className={grantsHeaderCountClassName}>{count}</span>
    </div>
  )
}

export function GrantEditorList({ children }: { children: ReactNode }) {
  return <ul className={grantsListClassName}>{children}</ul>
}

interface GrantEditorRowProps {
  entry: GrantEditorEntry
  saving: boolean
  canEdit: boolean
  // 保存前の追加・削除予定。両立しないので boolean 2 個でなく union で持つ。
  status?: GrantEditorRowStatus
  // 役割編集モードでは行のメタ枠を表示し、サブ行に既定役割を併記しない。
  showRole?: boolean
  onRemove: (email: string) => void
  // showRole が true のとき、行のメタ枠に差し込む内容。
  children?: ReactNode
}

export function GrantEditorRow({
  entry,
  saving,
  canEdit,
  status,
  showRole,
  onRemove,
  children,
}: GrantEditorRowProps) {
  const { t } = useT()
  const pendingRemove = status === 'pending-remove'
  return (
    <li
      className={cn(
        grantsRowClassName,
        status === 'pending-add' && 'bg-link-soft',
      )}
    >
      <AuthorAvatar
        id={entry.user?.id ?? entry.email}
        image={entry.user?.image ?? null}
        initial={getOwnerInitial(entry.user?.name ?? null, entry.email)}
      />
      <div className={grantsRowBodyClassName}>
        <div
          className={cn(
            grantsRowTitleClassName,
            entry.user?.name && 'font-medium',
            pendingRemove && 'text-faint line-through',
          )}
        >
          {entry.user?.name ?? entry.email}
        </div>
        <div
          className={cn(
            grantsRowSubClassName,
            entry.user ? 'text-muted-foreground' : 'text-faint',
            pendingRemove && 'text-faint line-through',
          )}
        >
          {showRole
            ? entry.user
              ? entry.email
              : t('visibilityDialog.grants.pending')
            : entry.user
              ? `${entry.email} · ${t('visibilityDialog.grants.viewer')}`
              : t('visibilityDialog.grants.pending')}
        </div>
      </div>
      {showRole ? (
        <div className={grantsRowMetaClassName}>{children}</div>
      ) : null}
      {status ? (
        <span
          className={cn(
            grantsRowStatusClassName,
            pendingRemove ? 'text-muted-foreground' : 'text-link',
          )}
        >
          {status === 'pending-add'
            ? t('visibilityDialog.grants.status.pendingAdd')
            : t('visibilityDialog.grants.status.pendingRemove')}
        </span>
      ) : null}
      {canEdit ? (
        <IconButton
          type="button"
          icon={IconX}
          size="sm"
          aria-label={t('visibilityDialog.grants.removeAria', {
            email: entry.email,
          })}
          disabled={saving}
          onClick={() => onRemove(entry.email)}
        />
      ) : null}
    </li>
  )
}
