import { CredentialTable } from './credential-table'
import { useState } from 'react'
import { Form, useActionData, useNavigation, useSubmit } from 'react-router'
import { SettingsSection } from '~/components/form/settings-section'
import { TeamMuted } from '~/components/form/team-muted'
import { Button } from '~/components/ui/button'
import { TableCell, TableRow } from '~/components/ui/table'
import { useT } from '~/hooks/use-t'
import type { Locale } from '~/i18n/messages'
import { formatRelative } from '~/lib/datetime'
import type { CliRefreshCredentialFamily } from '~/services/cli-refresh-credentials.server'
import { ConfirmActionDialog } from './confirm-action-dialog'

export function CliSessionsSection({
  cliFamilies,
}: {
  cliFamilies: CliRefreshCredentialFamily[]
}) {
  const actionData = useActionData<{ kind: string }>()
  const navigation = useNavigation()
  const [revokeAllOpen, setRevokeAllOpen] = useState(false)
  const { locale, t } = useT()

  return (
    <>
      <SettingsSection
        title={t('settings.cli.title')}
        description={t('team.tokens.cli.body')}
        actions={
          cliFamilies.length > 0 ? (
            <Button
              className="max-stack:hidden"
              variant="outline"
              size="sm"
              type="button"
              onClick={() => setRevokeAllOpen(true)}
            >
              {t('team.tokens.cli.revokeAll')}
            </Button>
          ) : undefined
        }
      >
        {actionData?.kind === 'cli-revoke-noop' ? (
          <p role="status" className="text-muted-foreground text-sm">
            {t('team.tokens.cli.alreadyRevoked')}
          </p>
        ) : null}
        <CredentialTable
          empty={cliFamilies.length === 0}
          emptyMessage={t('team.tokens.cli.empty')}
        >
          {cliFamilies.map((family) => (
            <CliFamilyRow
              key={family.familyId}
              family={family}
              locale={locale}
            />
          ))}
        </CredentialTable>
        {cliFamilies.length > 0 ? (
          <>
            <Button
              className="stack:hidden"
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
      </SettingsSection>
    </>
  )
}

function CliFamilyRow({
  family,
  locale,
}: {
  family: CliRefreshCredentialFamily
  locale: Locale
}) {
  const submit = useSubmit()
  const navigation = useNavigation()
  const [open, setOpen] = useState(false)
  const { t } = useT()
  const name =
    family.preset === 'publisher'
      ? (family.publisherClientName ?? t('team.tokens.cli.session'))
      : (family.deviceName ?? t('team.tokens.cli.session'))
  const identity = `${name} · ${family.familyId.slice(-8)}`
  const pending =
    navigation.state !== 'idle' &&
    navigation.formData?.get('intent') === 'revoke-cli-family' &&
    navigation.formData.get('familyId') === family.familyId
  return (
    <TableRow>
      <TableCell>
        <div className="flex min-w-0 flex-col gap-1 [overflow-wrap:anywhere]">
          <span className="font-medium">{identity}</span>
          <TeamMuted className="nav:hidden">
            {t('team.tokens.table.lastUsed')}:{' '}
            {family.lastUsedAt
              ? formatRelative(family.lastUsedAt, locale)
              : '—'}
          </TeamMuted>
          <TeamMuted className="overflow-visible text-clip whitespace-normal">
            {t('team.tokens.cli.preset')}:{' '}
            {t(`team.tokens.cli.preset.${family.preset ?? 'unrestricted'}`)}
          </TeamMuted>
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
        <div className="flex justify-end">
          <ConfirmActionDialog
            trigger={
              <Button
                variant="outline"
                size="sm"
                type="button"
                disabled={pending}
                aria-label={`${t('team.tokens.revoke')} ${identity}`}
              >
                {t('team.tokens.revoke')}
              </Button>
            }
            open={open}
            onOpenChange={setOpen}
            title={t('team.tokens.revoke')}
            description={t('settings.revoke.body', { name: identity })}
            action={t('team.tokens.revoke')}
            pending={pending}
            onConfirm={() =>
              submit(
                { intent: 'revoke-cli-family', familyId: family.familyId },
                { method: 'post', action: '/settings/tokens' },
              )
            }
          />
        </div>
      </TableCell>
    </TableRow>
  )
}
