import { CredentialTable } from './credential-table'
import { useState } from 'react'
import { SettingsSection } from '~/components/form/settings-section'
import { TeamMuted } from '~/components/form/team-muted'
import { Button } from '~/components/ui/button'
import { TableCell, TableRow } from '~/components/ui/table'
import { useT } from '~/hooks/use-t'
import type { Locale } from '~/i18n/messages'
import { formatRelative } from '~/lib/datetime'
import type { CliRefreshCredentialFamily } from '~/services/cli-refresh-credentials.server'
import { RevokeDialog, type RevokeTarget } from './revoke-dialog'

export function CliSessionsSection({
  cliFamilies,
}: {
  cliFamilies: CliRefreshCredentialFamily[]
}) {
  const [dialog, setDialog] = useState<{
    target: RevokeTarget
    triggerId: string
  } | null>(null)
  const [noop, setNoop] = useState(false)
  function open(target: RevokeTarget, triggerId: string) {
    setNoop(false)
    setDialog({ target, triggerId })
  }
  const { locale, t } = useT()

  return (
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
            id="revoke-all-desktop"
            onClick={(event) =>
              open(
                { intent: 'revoke-all-cli-families' },
                event.currentTarget.id,
              )
            }
          >
            {t('team.tokens.cli.revokeAll')}
          </Button>
        ) : undefined
      }
    >
      {noop ? (
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
            onRevoke={open}
            family={family}
            locale={locale}
          />
        ))}
      </CredentialTable>
      {cliFamilies.length > 0 ? (
        <Button
          className="stack:hidden"
          variant="outline"
          size="sm"
          type="button"
          id="revoke-all-phone"
          onClick={(event) =>
            open({ intent: 'revoke-all-cli-families' }, event.currentTarget.id)
          }
        >
          {t('team.tokens.cli.revokeAll')}
        </Button>
      ) : null}
      {dialog && (
        <RevokeDialog
          target={dialog.target}
          returnFocusId={dialog.triggerId}
          onClose={() => setDialog(null)}
          onAlreadyRevoked={() => setNoop(true)}
        />
      )}
    </SettingsSection>
  )
}

function CliFamilyRow({
  family,
  locale,
  onRevoke,
}: {
  onRevoke: (target: RevokeTarget, triggerId: string) => void
  family: CliRefreshCredentialFamily
  locale: Locale
}) {
  const { t } = useT()
  const name =
    family.preset === 'publisher'
      ? (family.publisherClientName ?? t('team.tokens.cli.session'))
      : (family.deviceName ?? t('team.tokens.cli.session'))
  const identity = `${name} · ${family.familyId.slice(-8)}`
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
          <Button
            variant="outline"
            size="sm"
            type="button"
            id={`revoke-family-${family.familyId}`}
            onClick={(event) =>
              onRevoke(
                {
                  intent: 'revoke-cli-family',
                  familyId: family.familyId,
                  name: identity,
                },
                event.currentTarget.id,
              )
            }
            aria-label={`${t('team.tokens.revoke')} ${identity}`}
          >
            {t('team.tokens.revoke')}
          </Button>
        </div>
      </TableCell>
    </TableRow>
  )
}
