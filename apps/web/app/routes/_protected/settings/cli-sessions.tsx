import { useState, type ReactNode } from 'react'
import { Form, useActionData, useNavigation } from 'react-router'
import { SettingsPage } from '~/components/form/settings-page'
import { SettingsSection } from '~/components/form/settings-section'
import { TableEmptyRow } from '~/components/form/table-empty-row'
import { TeamMuted } from '~/components/form/team-muted'
import { Button } from '~/components/ui/button'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '~/components/ui/table'
import { useT } from '~/hooks/use-t'
import type { Locale } from '~/i18n/messages'
import { formatRelative } from '~/lib/datetime'
import { stringValue } from '~/lib/form'
import { requireUser } from '~/middleware/context'
import {
  listCliRefreshCredentialFamilies,
  revokeAllCliRefreshCredentialFamilies,
  revokeCliRefreshCredentialFamily,
  type CliRefreshCredentialFamily,
} from '~/services/cli-refresh-credentials.server'
import { createDb } from '~/services/db.server'
import { ConfirmActionDialog } from './+components/confirm-action-dialog'
import { TeamActions } from './+components/team-actions'
import { TeamUser } from './+components/team-user'
import type { Route } from './+types/cli-sessions'

type ActionData = { kind: 'cli-revoke-noop' } | null

export async function loader({ context }: Route.LoaderArgs) {
  const user = requireUser(context)
  const cliFamilies = await listCliRefreshCredentialFamilies(
    createDb(),
    user.id,
  )
  return { cliFamilies }
}

export async function action({
  request,
  context,
}: Route.ActionArgs): Promise<ActionData> {
  const user = requireUser(context)
  const form = await request.formData()
  const intent = stringValue(form.get('intent'))
  const db = createDb()

  if (intent === 'revoke-cli-family') {
    const familyId = stringValue(form.get('familyId'))
    if (!familyId) return null
    const result = await revokeCliRefreshCredentialFamily(db, user.id, familyId)
    return result === 'noop' ? { kind: 'cli-revoke-noop' } : null
  }
  if (intent === 'revoke-all-cli-families') {
    await revokeAllCliRefreshCredentialFamilies(db, user.id)
  }
  return null
}

export default function CliSessionsPage({ loaderData }: Route.ComponentProps) {
  const actionData = useActionData<typeof action>()
  const navigation = useNavigation()
  const [revokeAllOpen, setRevokeAllOpen] = useState(false)
  const { locale, t } = useT()

  return (
    <SettingsPage>
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
              action="/settings/cli-sessions"
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
              pending={
                navigation.state !== 'idle' &&
                navigation.formData?.get('intent') === 'revoke-all-cli-families'
              }
              onConfirm={() => {
                const form = document.getElementById(
                  'revoke-all-cli-families-form',
                )
                if (form instanceof HTMLFormElement) form.requestSubmit()
              }}
            />
          </>
        ) : null}
        <CredentialTable empty={loaderData.cliFamilies.length === 0}>
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
}: {
  children: ReactNode
  empty: boolean
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
          <TableEmptyRow colSpan={4}>
            {t('team.tokens.cli.empty')}
          </TableEmptyRow>
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
  const navigation = useNavigation()
  const { t } = useT()
  const pending =
    navigation.state !== 'idle' &&
    navigation.formData?.get('intent') === 'revoke-cli-family' &&
    navigation.formData.get('familyId') === family.familyId
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
          <Form method="post" action="/settings/cli-sessions">
            <input type="hidden" name="intent" value="revoke-cli-family" />
            <input type="hidden" name="familyId" value={family.familyId} />
            <Button
              variant="outline"
              size="sm"
              type="submit"
              disabled={pending}
            >
              {t('team.tokens.revoke')}
            </Button>
          </Form>
        </TeamActions>
      </TableCell>
    </TableRow>
  )
}
