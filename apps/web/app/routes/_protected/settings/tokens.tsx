import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Form, useActionData, useFetcher, useNavigation } from 'react-router'
import { InlineFields } from '~/components/form/inline-fields'
import { SettingsPage } from '~/components/form/settings-page'
import { SettingsSection } from '~/components/form/settings-section'
import { Button } from '~/components/ui/button'
import { Field, FieldError, FieldLabel } from '~/components/ui/field'
import { Input } from '~/components/ui/input'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '~/components/ui/table'
import { TableEmptyRow } from '~/components/form/table-empty-row'
import { CreatedTokenPanel } from './+components/created-token-panel'
import { ConfirmActionDialog } from './+components/confirm-action-dialog'
import { TeamActions } from './+components/team-actions'
import { TeamMuted } from '~/components/form/team-muted'
import { TeamUser } from './+components/team-user'
import type { Route } from './+types/tokens'
import { useT } from '~/hooks/use-t'
import type { Locale } from '~/i18n/messages'
import { formatRelative } from '~/lib/datetime'
import { stringValue } from '~/lib/form'
import { requireUser } from '~/middleware/context'
import {
  createApiToken,
  listApiTokens,
  revokeApiToken,
  type ApiTokenListItem,
} from '~/services/api-tokens.server'
import { createDb } from '~/services/db.server'
import {
  listCliRefreshCredentialFamilies,
  revokeAllCliRefreshCredentialFamilies,
  revokeCliRefreshCredentialFamily,
  type CliRefreshCredentialFamily,
} from '~/services/cli-refresh-credentials.server'
import { isDevScreenStateRequest } from '~/services/dev-screen-state.server'
import { Link } from 'react-router'
import { withLang } from '~/lib/connect-link'

const MAX_TOKEN_NAME_LENGTH = 100

type ActionData =
  | { kind: 'created'; token: string; name: string }
  | { kind: 'name-required' }
  | { kind: 'name-too-long' }
  | { kind: 'cli-revoke-noop' }

export async function loader({ context, request }: Route.LoaderArgs) {
  const user = requireUser(context)
  const db = createDb()
  const [tokens, cliFamilies] = await Promise.all([
    listApiTokens(db, user.id),
    listCliRefreshCredentialFamilies(db, user.id),
  ])
  const createdToken = isDevScreenStateRequest(
    request,
    'settings-tokens/created-secret',
  )
    ? { name: 'CLI deploy', token: 'as_dev_screen_created_secret' }
    : null
  return { tokens, cliFamilies, createdToken }
}

export async function action({
  request,
  context,
}: Route.ActionArgs): Promise<ActionData | null> {
  const user = requireUser(context)
  const form = await request.formData()
  const intent = stringValue(form.get('intent'))
  const db = createDb()

  if (intent === 'create') {
    const name = stringValue(form.get('name'))?.trim() ?? ''
    if (!name) return { kind: 'name-required' }
    if (name.length > MAX_TOKEN_NAME_LENGTH) return { kind: 'name-too-long' }
    const result = await createApiToken(db, user.id, name)
    return { kind: 'created', token: result.token, name: result.name }
  }

  if (intent === 'revoke') {
    const tokenId = stringValue(form.get('tokenId'))
    if (!tokenId) return null
    await revokeApiToken(db, user.id, tokenId)
    return null
  }

  if (intent === 'revoke-cli-family') {
    const familyId = stringValue(form.get('familyId'))
    if (!familyId) return null
    const result = await revokeCliRefreshCredentialFamily(db, user.id, familyId)
    if (result === 'noop') return { kind: 'cli-revoke-noop' }
    return null
  }

  if (intent === 'revoke-all-cli-families') {
    await revokeAllCliRefreshCredentialFamilies(db, user.id)
    return null
  }

  return null
}

export default function ApiTokensPage({ loaderData }: Route.ComponentProps) {
  const actionData = useActionData<typeof action>()
  const navigation = useNavigation()
  const createFormRef = useRef<HTMLFormElement>(null)
  const [revokeAllOpen, setRevokeAllOpen] = useState(false)
  const createdToken = useMemo(
    () =>
      actionData?.kind === 'created'
        ? { name: actionData.name, token: actionData.token }
        : loaderData.createdToken,
    [actionData, loaderData.createdToken],
  )
  const { locale, t } = useT()
  const isCreating = Boolean(
    navigation.formAction === '/settings/tokens' &&
    navigation.formData?.get('intent') === 'create',
  )
  const createError =
    actionData?.kind === 'name-required'
      ? t('team.tokens.nameRequired')
      : actionData?.kind === 'name-too-long'
        ? t('team.tokens.nameTooLong')
        : undefined

  useEffect(() => {
    if (actionData?.kind === 'created') createFormRef.current?.reset()
  }, [actionData])

  return (
    <SettingsPage>
      <SettingsSection
        title={t('team.tokens.api.title')}
        description={t('team.tokens.body')}
      >
        <Form ref={createFormRef} method="post" action="/settings/tokens">
          <input type="hidden" name="intent" value="create" />
          <InlineFields>
            <Field
              className="min-w-0"
              data-invalid={createError ? true : undefined}
            >
              <FieldLabel htmlFor="token-name" className="sr-only">
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
        </Form>

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
            <TokenRow key={token.id} token={token} locale={locale} />
          ))}
        </CredentialTable>
        <p className="text-sm">
          <Link
            className="text-link underline"
            to={withLang('/guides/cli', locale)}
          >
            {locale === 'ja' ? 'CLIの始め方を見る' : 'Read the CLI guide'}
          </Link>
        </p>
      </SettingsSection>
      <SettingsSection
        title={t('team.tokens.cli.title')}
        description={t('team.tokens.cli.body')}
      >
        {actionData?.kind === 'cli-revoke-noop' ? (
          <p role="status" className="text-muted-foreground text-sm">
            {t('team.tokens.cli.alreadyRevoked')}
          </p>
        ) : null}
        {loaderData.cliFamilies.length > 0 ? (
          <>
            <Button
              variant="outline"
              size="sm"
              type="button"
              onClick={() => setRevokeAllOpen(true)}
            >
              {t('team.tokens.cli.revokeAll')}
            </Button>
            <Form
              method="post"
              action="/settings/tokens"
              id="revoke-all-cli-families-form"
              className="hidden"
            >
              <input
                type="hidden"
                name="intent"
                value="revoke-all-cli-families"
              />
            </Form>
            <ConfirmActionDialog
              open={revokeAllOpen}
              onOpenChange={setRevokeAllOpen}
              title={t('team.tokens.cli.revokeAllConfirm.title')}
              description={t('team.tokens.cli.revokeAllConfirm.body')}
              action={t('team.tokens.cli.revokeAll')}
              pending={navigation.state !== 'idle'}
              onConfirm={() => {
                const form = document.getElementById(
                  'revoke-all-cli-families-form',
                )
                if (form instanceof HTMLFormElement) form.requestSubmit()
              }}
            />
          </>
        ) : null}
        <CredentialTable
          empty={loaderData.cliFamilies.length === 0}
          emptyMessage={t('team.tokens.cli.empty')}
        >
          {loaderData.cliFamilies.map((family) => (
            <CliFamilyRow
              key={family.familyId}
              family={family}
              locale={locale}
            />
          ))}
        </CredentialTable>
      </SettingsSection>
    </SettingsPage>
  )
}

function CredentialTable({
  children,
  empty,
  emptyMessage,
}: {
  children: ReactNode
  empty: boolean
  emptyMessage: string
}) {
  const { t } = useT()
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>{t('team.tokens.table.name')}</TableHead>
          <TableHead className="max-phone:hidden">
            {t('team.tokens.table.created')}
          </TableHead>
          <TableHead className="max-nav:hidden">
            {t('team.tokens.table.lastUsed')}
          </TableHead>
          <TableHead className="text-right">
            {t('team.tokens.table.actions')}
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {children}
        {empty ? (
          <TableEmptyRow colSpan={4}>{emptyMessage}</TableEmptyRow>
        ) : null}
      </TableBody>
    </Table>
  )
}

function CliFamilyRow({
  family,
  locale,
}: {
  family: CliRefreshCredentialFamily
  locale: Locale
}) {
  const fetcher = useFetcher()
  const { t } = useT()
  return (
    <TableRow>
      <TableCell>
        <div
          className="max-w-96 min-w-0 truncate"
          title={family.deviceName ?? t('team.tokens.cli.session')}
        >
          <TeamUser name={family.deviceName ?? t('team.tokens.cli.session')} />
        </div>
      </TableCell>
      <TableCell className="max-phone:hidden">
        <TeamMuted>{formatRelative(family.createdAt, locale)}</TeamMuted>
      </TableCell>
      <TableCell className="max-nav:hidden">
        <TeamMuted>
          {family.lastUsedAt ? formatRelative(family.lastUsedAt, locale) : '—'}
        </TeamMuted>
      </TableCell>
      <TableCell>
        <TeamActions>
          <fetcher.Form method="post" action="/settings/tokens">
            <input type="hidden" name="intent" value="revoke-cli-family" />
            <input type="hidden" name="familyId" value={family.familyId} />
            <Button
              variant="outline"
              size="sm"
              type="submit"
              disabled={fetcher.state !== 'idle'}
            >
              {t('team.tokens.revoke')}
            </Button>
          </fetcher.Form>
        </TeamActions>
      </TableCell>
    </TableRow>
  )
}

function TokenRow({
  token,
  locale,
}: {
  token: ApiTokenListItem
  locale: Locale
}) {
  const fetcher = useFetcher()
  const { t } = useT()
  const pendingForToken = fetcher.state !== 'idle'

  return (
    <TableRow>
      <TableCell>
        <div className="max-w-96 min-w-0 truncate" title={token.name}>
          <TeamUser name={token.name} />
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
        <TeamActions>
          <fetcher.Form method="post" action="/settings/tokens">
            <input type="hidden" name="intent" value="revoke" />
            <input type="hidden" name="tokenId" value={token.id} />
            <Button
              variant="outline"
              size="sm"
              type="submit"
              disabled={pendingForToken}
            >
              {t('team.tokens.revoke')}
            </Button>
          </fetcher.Form>
        </TeamActions>
      </TableCell>
    </TableRow>
  )
}
