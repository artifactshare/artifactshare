import { useSettingsEntryChange } from '~/hooks/use-settings-entry-change'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useActionData, useFetcher } from 'react-router'
import { InlineFields } from '~/components/form/inline-fields'
import { SettingsPage } from '~/components/form/settings-page'
import { SettingsSection } from '~/components/form/settings-section'
import { TeamMuted } from '~/components/form/team-muted'
import { Button } from '~/components/ui/button'
import { Field, FieldError, FieldLabel } from '~/components/ui/field'
import { Input } from '~/components/ui/input'
import { TableCell, TableRow } from '~/components/ui/table'
import { useT } from '~/hooks/use-t'
import type { Locale } from '~/i18n/messages'
import { useRelativeTime } from '~/components/app/render-clock'
import { withLang } from '~/lib/connect-link'
import type { ApiTokenListItem } from '~/services/api-tokens.server'
import { CredentialTable } from './credential-table'
import { StatusBanner } from './settings-banner'
import { CreatedTokenPanel } from './created-token-panel'
import { RevokeDialog } from './revoke-dialog'
import { CliSessionsSection } from './cli-sessions-section'
import type { action, loader } from '../_content/tokens'
export const MAX_TOKEN_NAME_LENGTH = 100
export default function ApiTokensPage({
  loaderData,
}: {
  loaderData: Awaited<ReturnType<typeof loader>>
}) {
  const [target, setTarget] = useState<ApiTokenListItem | null>(null)
  const fetcher = useFetcher<typeof action>()
  // A submission made before hydration arrives as the route's action data.
  const nativeResult = useActionData<typeof action>()
  const actionData =
    fetcher.state === 'idle' ? (fetcher.data ?? nativeResult) : undefined
  const [successCount, setSuccessCount] = useState(() =>
    nativeResult?.ok && nativeResult.code === 'created' ? 1 : 0,
  )
  useSettingsEntryChange(() => {
    fetcher.reset()
    setSuccessCount(0)
  })
  const onRevoked = () => setSuccessCount((count) => count + 1)
  const createFormRef = useRef<HTMLFormElement>(null)
  const createdToken = useMemo(
    () =>
      actionData?.ok && actionData.code === 'created'
        ? { name: actionData.name, token: actionData.token }
        : loaderData.createdToken,
    [actionData, loaderData.createdToken],
  )
  const { locale, t } = useT()
  const isCreating = fetcher.state !== 'idle'
  const createError =
    actionData?.code === 'name-required'
      ? t('team.tokens.nameRequired')
      : actionData?.code === 'name-too-long'
        ? t('team.tokens.nameTooLong')
        : undefined

  useEffect(() => {
    if (fetcher.data?.ok && fetcher.data.code === 'created') {
      createFormRef.current?.reset()
      setSuccessCount((count) => count + 1)
    }
  }, [fetcher.data])

  return (
    <SettingsPage>
      {successCount > 0 && <StatusBanner key={successCount} status="ok" />}
      <SettingsSection
        title={t('settings.connections')}
        description={t('settings.connections.body')}
      />
      <CliSessionsSection
        cliFamilies={loaderData.cliFamilies}
        onRevoked={onRevoked}
      />
      <SettingsSection
        headingId="api-tokens-heading"
        title={t('team.tokens.api.title')}
        description={t('team.tokens.body')}
      >
        <fetcher.Form
          ref={createFormRef}
          onSubmit={() => setSuccessCount(0)}
          method="post"
          action="/settings/tokens"
        >
          <input type="hidden" name="intent" value="create" />
          <InlineFields>
            <Field
              className="min-w-0"
              data-invalid={createError ? true : undefined}
            >
              <FieldLabel htmlFor="token-name">
                {t('team.tokens.name')}
              </FieldLabel>
              <Input
                id="token-name"
                name="name"
                type="text"
                maxLength={MAX_TOKEN_NAME_LENGTH}
                placeholder={t('team.tokens.namePlaceholder')}
                disabled={isCreating}
                aria-invalid={createError ? true : undefined}
                aria-describedby={createError ? 'token-name-error' : undefined}
              />
              <FieldError id="token-name-error">{createError}</FieldError>
            </Field>
            <Button
              variant="outline"
              size="sm"
              type="submit"
              disabled={isCreating}
            >
              {t('team.tokens.create')}
            </Button>
          </InlineFields>
        </fetcher.Form>

        {createdToken ? (
          <CreatedTokenPanel
            name={createdToken.name}
            token={createdToken.token}
          />
        ) : null}

        <CredentialTable
          empty={loaderData.tokens.length === 0}
          emptyMessage={t('team.tokens.empty')}
        >
          {loaderData.tokens.map((token) => (
            <TokenRow
              key={token.id}
              token={token}
              locale={locale}
              onRevoke={() => setTarget(token)}
            />
          ))}
        </CredentialTable>
        {target && (
          <RevokeDialog
            onRevoked={onRevoked}
            target={{ intent: 'revoke', tokenId: target.id, name: target.name }}
            fallbackFocusId="api-tokens-heading"
            returnFocusId={`revoke-${target.id}`}
            onClose={() => setTarget(null)}
          />
        )}
        <p className="text-sm">
          <Link
            className="text-link underline"
            to={withLang('/guides/cli', locale)}
          >
            {locale === 'ja' ? 'CLIの始め方を見る' : 'Read the CLI guide'}
          </Link>
        </p>
      </SettingsSection>
    </SettingsPage>
  )
}

function TokenRow({
  token,
  locale,
  onRevoke,
}: {
  onRevoke: () => void
  token: ApiTokenListItem
  locale: Locale
}) {
  const formatRelative = useRelativeTime()
  const { t } = useT()
  return (
    <TableRow>
      <TableCell>
        <div className="flex min-w-0 flex-col gap-1 [overflow-wrap:anywhere]">
          <span className="font-medium">{token.name}</span>
          <TeamMuted className="nav:hidden">
            {t('team.tokens.table.lastUsed')}:{' '}
            {token.lastUsedAt ? formatRelative(token.lastUsedAt, locale) : '—'}
          </TeamMuted>
        </div>
      </TableCell>
      <TableCell className="max-phone:hidden">
        <TeamMuted>{formatRelative(token.createdAt, locale)}</TeamMuted>
      </TableCell>
      <TableCell className="max-nav:hidden">
        <TeamMuted>
          {token.lastUsedAt ? formatRelative(token.lastUsedAt, locale) : '—'}
        </TeamMuted>
      </TableCell>
      <TableCell>
        <div className="flex justify-end">
          <Button
            variant="outline"
            size="sm"
            type="button"
            id={`revoke-${token.id}`}
            onClick={onRevoke}
            aria-label={`${t('team.tokens.revoke')} ${token.name}`}
          >
            {t('team.tokens.revoke')}
          </Button>
        </div>
      </TableCell>
    </TableRow>
  )
}
