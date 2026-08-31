import { AuthorAvatar } from '~/components/app/author-avatar'
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
  grantsRowStatusClassName,
  grantsRowSubClassName,
  grantsRowTitleClassName,
  grantsYouMarkClassName,
} from '~/components/app/grant-editor-styles'
import { IconButton } from '~/components/app/icon-button'
import { Button } from '~/components/ui/button'
import type { Translator } from '~/lib/i18n'
import { MAX_GRANT_EMAILS } from '~/lib/grant-emails'
import { cn } from '~/lib/utils'
import type { UserInfo } from '~/lib/user'
import { IconX } from '@tabler/icons-react'
import { RecipientSuggestionInput } from '~/components/app/recipient-suggestion-input'
import { parseGrantEmails } from '~/lib/grant-emails'

interface UploadInitialGrantsProps {
  grantInput: string
  grantEmails: ReadonlyArray<string>
  uploading: boolean
  user: UserInfo
  t: Translator['t']
  onGrantInputChange: (value: string) => void
  onCommitGrantInput: (value?: string) => void
  onRemoveGrantEmail: (email: string) => void
}

export function UploadInitialGrants({
  grantInput,
  grantEmails,
  uploading,
  user,
  t,
  onGrantInputChange,
  onCommitGrantInput,
  onRemoveGrantEmail,
}: UploadInitialGrantsProps) {
  const limitReached = grantEmails.length >= MAX_GRANT_EMAILS
  return (
    <section
      className="flex flex-col gap-[var(--spacing-2)] pt-[var(--spacing-1)]"
      aria-label={t('visibilityDialog.grants.sectionAria')}
    >
      <div className={grantsInputRowClassName}>
        <RecipientSuggestionInput
          className={grantsInputClassName}
          value={grantInput}
          disabled={uploading || limitReached}
          context={{ kind: 'upload' }}
          excludedEmails={grantEmails}
          ownerEmail={user.email}
          onChange={onGrantInputChange}
          onCommit={onCommitGrantInput}
          labels={{
            placeholder: t('visibilityDialog.grants.inputPlaceholder'),
            loading: t('visibilityDialog.grants.suggestions.loading'),
            empty: t('visibilityDialog.grants.suggestions.empty'),
            count: (count) =>
              t('visibilityDialog.grants.suggestions.count', { count }),
          }}
        />
        <Button
          type="button"
          variant="outline"
          size="default"
          disabled={
            uploading ||
            limitReached ||
            parseGrantEmails(grantInput, user.email).length === 0
          }
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => onCommitGrantInput()}
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

      <div className={grantsHeaderClassName}>
        <span className={grantsHeaderTitleClassName}>
          {t('visibilityDialog.grants.header.title.private')}
        </span>
        <span className={grantsHeaderCountClassName}>
          {t('visibilityDialog.grants.header.count.private', {
            count: grantEmails.length + 1,
          })}
        </span>
      </div>
      <ul className={grantsListClassName}>
        <li className={grantsRowClassName}>
          <AuthorAvatar
            id={user.id}
            image={user.image}
            initial={user.initial}
          />
          <div className={grantsRowBodyClassName}>
            <div className={cn(grantsRowTitleClassName, 'font-medium')}>
              {user.name ?? user.email}
              <span className={grantsYouMarkClassName}>
                {t('visibilityDialog.grants.you')}
              </span>
            </div>
            <div className={cn(grantsRowSubClassName, 'text-muted-foreground')}>
              {user.email} · {t('visibilityDialog.grants.owner')}
            </div>
          </div>
        </li>
        {grantEmails.map((email) => (
          <li key={email} className={cn(grantsRowClassName, 'bg-link-soft')}>
            <AuthorAvatar id={email} image={null} initial={email[0]} />
            <div className={grantsRowBodyClassName}>
              <div className={grantsRowTitleClassName}>{email}</div>
              <div className={cn(grantsRowSubClassName, 'text-faint')}>
                {t('visibilityDialog.grants.pending')}
              </div>
            </div>
            <span className={cn(grantsRowStatusClassName, 'text-link')}>
              {t('visibilityDialog.grants.status.pendingAdd')}
            </span>
            <IconButton
              type="button"
              icon={IconX}
              size="sm"
              aria-label={t('visibilityDialog.grants.removeAria', {
                email,
              })}
              disabled={uploading}
              onClick={() => onRemoveGrantEmail(email)}
            />
          </li>
        ))}
      </ul>
    </section>
  )
}
