import { useSettingsEntryChange } from '~/hooks/use-settings-entry-change'
import { IconAlertTriangle, IconPlug as Plug } from '@tabler/icons-react'
import { useEffect, useState, type ReactNode } from 'react'
import { useFetcher, data, Link, useOutletContext } from 'react-router'
import { SettingsPage } from '~/components/form/settings-page'
import { readSlackInstallFailure } from '~/lib/slack-install-notice.server'
import { settingsFailure } from '~/lib/settings-submission'
import {
  confirmationResult,
  runConfirmedMutation,
} from '~/lib/settings-confirmation'
import { ConfirmActionDialog } from '../+components/confirm-action-dialog'
import {
  SettingsBanner,
  StatusBanner,
  settingsNotice,
} from '../+components/settings-banner'
import { Inline } from '~/components/layout/inline'
import { Stack } from '~/components/layout/stack'
import { Button } from '~/components/ui/button'
import { Badge } from '~/components/ui/badge'
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '~/components/ui/card'
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
} from '~/components/ui/empty'
import { SettingsSection } from '~/components/form/settings-section'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '~/components/ui/tooltip'
import type { Route } from './+types/integrations'
import type { SettingsLayoutContext } from '../_layout'
import { useT } from '~/hooks/use-t'
import type { Locale } from '~/i18n/messages'
import { formatRelative } from '~/lib/datetime'
import { stringValue } from '~/lib/form'
import { requireUser } from '~/middleware/context'
import { createDb } from '~/services/db.server'
import {
  deleteWorkspaceSlackConnection,
  listWorkspaceSlackConnections,
  type SlackConnectionListItem,
} from '~/services/slack.server'
import type { ScreenSpec } from '~/types/screen'

export const screen = {
  id: 'settings-integrations',
  route: {
    en: '/settings/integrations',
  },
  auth: 'team-owner',
  loop: 'share',
  metric: '連携による共有利用を増やす',
  role: '連携サービスを管理する',
  primaryAction: '連携を設定する',
  states: [
    {
      id: 'slack-disconnect-confirmation',
      description:
        'Destructive Slack disconnect confirmation explaining lost previews and notifications',
      setup: {
        scenario: 'settings-integrations/slack-connected',
        reseedBeforeCapture: true,
        interactions: [
          {
            action: 'click',
            selector: 'button:has-text("Disconnect")',
            readySelector: '[role="alertdialog"]',
          },
        ],
      },
    },
    {
      id: 'slack-disconnect-dialog-pending',
      description: 'Slack disconnect pending in the open confirmation',
      setup: {
        scenario: 'settings-integrations/slack-connected',
        reseedBeforeCapture: true,
        actionResponse: {
          route: '/settings/integrations',
          method: 'POST',
          intent: 'disconnect-slack',
          pending: true,
        },
        interactions: [
          {
            action: 'click',
            selector: 'button:text-is("Disconnect")',
            readySelector: '[role="alertdialog"]',
          },
          {
            action: 'click',
            selector: '[role="alertdialog"] button:text-is("Disconnect")',
            readySelector:
              '[role="alertdialog"] [data-slot="alert-dialog-action"]:disabled',
          },
        ],
      },
    },
    {
      id: 'slack-disconnect-dialog-error',
      description: 'Slack disconnect error in the open confirmation',
      setup: {
        scenario: 'settings-integrations/slack-connected',
        reseedBeforeCapture: true,
        actionResponse: {
          route: '/settings/integrations',
          method: 'POST',
          intent: 'disconnect-slack',
          status: 409,
          data: {
            ok: false,
            intent: 'disconnect-slack',
            code: 'external-failed',
            connectionId:
              'dev-screen-team-settings-integrations-slack-connected-slack',
          },
        },
        interactions: [
          {
            action: 'click',
            selector: 'button:text-is("Disconnect")',
            readySelector: '[role="alertdialog"]',
          },
          {
            action: 'click',
            selector: '[role="alertdialog"] button:text-is("Disconnect")',
            readySelector: '[role="alertdialog"] [role="alert"]',
          },
        ],
      },
    },
    {
      id: 'slack-disconnected',
      description:
        'Disconnected Slack connection with an explicit success notice',
      setup: {
        scenario: 'settings-integrations/slack-connected',
        reseedBeforeCapture: true,
        interactions: [
          { action: 'click', selector: 'button:text-is("Disconnect")' },
          {
            action: 'click',
            selector: '[role="alertdialog"] [data-slot="alert-dialog-action"]',
          },
        ],
        actionResponse: {
          route: '/settings/integrations',
          method: 'POST',
          intent: 'disconnect-slack',
          data: {
            ok: true,
            code: 'slack-disconnected',
            intent: 'disconnect-slack',
            connectionId:
              'dev-screen-team-settings-integrations-slack-connected-slack',
          },
        },
        postInteractionReady: {
          selector:
            'body:not(:has([id^="disconnect-"])) [role="status"][data-settings-status="slack-disconnected"]',
          description: 'Explicit disconnected notice',
        },
      },
    },
    {
      id: 'slack-member-empty',
      description: 'Member guidance to ask a workspace admin to connect Slack',
      setup: {
        auth: 'team-member',
        scenario: 'settings-integrations/slack-disconnected',
        reseedBeforeCapture: true,
      },
    },
    {
      id: 'slack-member-connected',
      description:
        'Connected Slack workspace with visible admin guidance for members',
      setup: {
        scenario: 'settings-integrations/slack-connected',
        reseedBeforeCapture: true,
        auth: 'team-member',
      },
    },
    {
      id: 'default',
      description: '連携設定',
      setup: {},
    },
    {
      id: 'slack-connected',
      description: 'Slack が接続済みの状態',
      setup: {
        scenario: 'settings-integrations/slack-connected',
      },
    },
    {
      id: 'slack-reauthorization',
      description: '閲覧リクエスト通知のために Slack の再認可が必要な状態',
      setup: {
        scenario: 'settings-integrations/slack-reauthorization',
      },
    },
    {
      id: 'slack-reauthorization-member',
      description: '非管理者に Slack の再認可が必要だと伝える状態',
      setup: {
        auth: 'team-member',
        scenario: 'settings-integrations/slack-reauthorization',
      },
    },
  ],
} satisfies ScreenSpec

export async function loader({ request, context }: Route.LoaderArgs) {
  const user = requireUser(context)
  const [connections, notice] = await Promise.all([
    listWorkspaceSlackConnections(createDb(), user.workspaceId),
    readSlackInstallFailure(request),
  ])
  return data(
    { connections, ...(notice && { launchFailure: notice.code }) },
    notice ? { headers: { 'Set-Cookie': notice.clearCookie } } : {},
  )
}

export async function action({ request, context }: Route.ActionArgs) {
  const form = await request.formData()
  const intent = stringValue(form.get('intent')) ?? ''
  const submit = async () => {
    const user = requireUser(context)
    if (intent !== 'disconnect-slack') return settingsFailure(intent, 'invalid')
    const connectionId = stringValue(form.get('connectionId'))
    if (!connectionId) return settingsFailure(intent, 'invalid')
    const result = await deleteWorkspaceSlackConnection(
      createDb(),
      user,
      connectionId,
    )
    if (result.kind !== 'ok') return settingsFailure(intent, result.kind)
    return data(
      { ok: true as const, code: 'slack-disconnected', intent, connectionId },
      { status: 200 },
    )
  }
  return intent === 'disconnect-slack' ? runConfirmedMutation(submit) : submit()
}

export async function clientAction({
  request,
  serverAction,
}: Route.ClientActionArgs) {
  const intent = (await request.clone().formData()).get('intent')
  return intent === 'disconnect-slack'
    ? confirmationResult(intent, serverAction)
    : serverAction()
}

export default function IntegrationsPage({
  loaderData,
}: Pick<Route.ComponentProps, 'loaderData'>) {
  const fetcher = useFetcher<typeof action>()
  useSettingsEntryChange(fetcher.reset)
  const [selected, setSelected] = useState<SlackConnectionListItem | null>(null)
  const [open, setOpen] = useState(false)
  const pending = fetcher.state !== 'idle'
  const result = pending ? undefined : fetcher.data
  useEffect(() => {
    if (result?.ok) setOpen(false)
  }, [result])
  const connections = result?.ok
    ? loaderData.connections.filter(
        (connection) => connection.id !== result.connectionId,
      )
    : loaderData.connections
  const { currentUserIsAdmin } = useOutletContext<SettingsLayoutContext>()
  const dialogRendered =
    open &&
    selected &&
    currentUserIsAdmin &&
    connections.some((connection) => connection.id === selected.id)
  return (
    <SettingsPage>
      {loaderData.launchFailure && (
        <StatusBanner status={loaderData.launchFailure} />
      )}
      {result?.ok && <StatusBanner status={result.code} />}
      {result && !result.ok && !dialogRendered && (
        <DisconnectFailure selected={selected} code={result.code} />
      )}
      {dialogRendered && (
        <DisconnectDialog
          selected={selected}
          fetcher={fetcher}
          close={(next) => {
            setOpen(next)
            // Dismissing ends the attempt: its failure is not repeated on
            // the page while the connection is still listed.
            if (!next && !pending && result && !result.ok) fetcher.reset()
          }}
        />
      )}
      <SlackConnections
        connections={connections}
        currentUserIsAdmin={currentUserIsAdmin}
        pendingId={pending ? selected?.id : undefined}
        onDisconnect={(connection) => {
          fetcher.reset()
          setSelected(connection)
          setOpen(true)
        }}
      />
    </SettingsPage>
  )
}

function SlackEmptyState({ canManage }: { canManage: boolean }) {
  const { t } = useT()
  return (
    <Empty>
      <EmptyHeader>
        <EmptyDescription>
          {t(
            canManage
              ? 'team.integrations.slack.empty'
              : 'team.integrations.slack.memberEmpty',
          )}
        </EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        {canManage ? (
          <Button asChild size="sm">
            <Link to="/integrations/slack/install">
              {t('team.integrations.slack.connect')}
            </Link>
          </Button>
        ) : (
          <AdminOnlyTooltip label={t('team.integrations.slack.adminOnly')}>
            <Button size="sm" type="button" disabled>
              {t('team.integrations.slack.connect')}
            </Button>
          </AdminOnlyTooltip>
        )}
      </EmptyContent>
    </Empty>
  )
}

export function SlackConnectionCard({
  connection,
  locale,
  canManage,
  pending,
  onDisconnect,
}: {
  onDisconnect: () => void
  connection: SlackConnectionListItem
  locale: Locale
  canManage: boolean
  pending: boolean
}) {
  const { t } = useT()
  const time = formatRelative(connection.installedAt, locale)
  const meta = connection.installedByName
    ? t('team.integrations.slack.installedBy', {
        time,
        name: connection.installedByName,
      })
    : t('team.integrations.slack.installed', { time })
  const adminOnly = t('team.integrations.slack.adminOnly')
  const reauthorizationAdminOnly = t(
    'team.integrations.slack.reauthorization.adminOnly',
  )

  return (
    <Card size="sm">
      <CardHeader>
        <Inline gap="3" align="center">
          <span
            className="bg-muted grid size-9 shrink-0 place-items-center rounded-[var(--r-md)] [&_svg]:size-5.5"
            aria-hidden="true"
          >
            <Plug size={22} />
          </span>
          <div>
            <CardTitle>{connection.teamName}</CardTitle>
            <CardDescription>{meta}</CardDescription>
          </div>
        </Inline>
      </CardHeader>
      {connection.needsReauthorization ? (
        <CardContent className="border-warning/30 bg-warning-soft border-y py-3">
          <Inline gap="2" align="start">
            <IconAlertTriangle
              className="text-warning size-4 shrink-0"
              aria-hidden="true"
            />
            <div className="space-y-1">
              <p className="text-sm font-medium">
                {t('team.integrations.slack.reauthorization.title')}
              </p>
              <p className="text-foreground text-sm">
                {t(
                  canManage
                    ? 'team.integrations.slack.reauthorization.body'
                    : 'team.integrations.slack.reauthorization.memberBody',
                )}
              </p>
            </div>
          </Inline>
        </CardContent>
      ) : null}
      <CardFooter className="max-stack:items-stretch max-stack:flex-col justify-between gap-[var(--spacing-3)]">
        <Badge
          variant={connection.needsReauthorization ? 'warning' : 'success'}
        >
          {t(
            connection.needsReauthorization
              ? 'team.integrations.slack.reauthorization.state'
              : 'team.integrations.slack.state',
          )}
        </Badge>
        <div className="max-stack:grid max-stack:grid-cols-2 flex gap-2">
          {connection.needsReauthorization ? (
            canManage ? (
              <Button asChild size="sm">
                <Link
                  to={`/integrations/slack/install?connection=${connection.id}`}
                >
                  {t('team.integrations.slack.reauthorization.action')}
                </Link>
              </Button>
            ) : (
              <AdminOnlyTooltip label={reauthorizationAdminOnly}>
                <Button
                  className="max-stack:w-full"
                  size="sm"
                  type="button"
                  disabled
                >
                  {t('team.integrations.slack.reauthorization.action')}
                </Button>
              </AdminOnlyTooltip>
            )
          ) : null}
          {canManage ? (
            <Button
              id={`disconnect-${connection.id}`}
              type="button"
              className="max-stack:w-full"
              variant="outline"
              size="sm"
              disabled={pending}
              onClick={onDisconnect}
            >
              {t('team.integrations.slack.disconnect')}
            </Button>
          ) : (
            <AdminOnlyTooltip label={adminOnly}>
              <Button
                className="max-stack:w-full"
                variant="outline"
                size="sm"
                type="button"
                disabled
              >
                {t('team.integrations.slack.disconnect')}
              </Button>
            </AdminOnlyTooltip>
          )}
        </div>
      </CardFooter>
    </Card>
  )
}

function AdminOnlyTooltip({
  label,
  children,
}: {
  label: string
  children: ReactNode
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        {/* disabled button はフォーカス不能なため、キーボードでもツールチップへ届くよう span を焦点対象にする */}
        {/* react-doctor-disable-next-line react-doctor/no-noninteractive-tabindex */}
        <span className="inline-flex" tabIndex={0}>
          {children}
        </span>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}

function SlackConnections({
  connections,
  currentUserIsAdmin,
  pendingId,
  onDisconnect,
}: {
  connections: SlackConnectionListItem[]
  currentUserIsAdmin: boolean
  pendingId?: string
  onDisconnect: (connection: SlackConnectionListItem) => void
}) {
  const { locale, t } = useT()
  return (
    <SettingsSection
      headingId="slack-heading"
      title={t('team.integrations.slack.title')}
      description={t('team.integrations.slack.body')}
    >
      {!currentUserIsAdmin ? (
        <p className="text-muted-foreground text-sm">
          {t('team.integrations.slack.memberGuidance')}
        </p>
      ) : null}
      {connections.length === 0 ? (
        <SlackEmptyState canManage={currentUserIsAdmin} />
      ) : (
        <>
          <Stack gap="3">
            {connections.map((connection) => (
              <SlackConnectionCard
                key={connection.id}
                connection={connection}
                locale={locale}
                canManage={currentUserIsAdmin}
                pending={connection.id === pendingId}
                onDisconnect={() => onDisconnect(connection)}
              />
            ))}
          </Stack>
          <div className="pt-4">
            {currentUserIsAdmin ? (
              <Button asChild variant="outline" size="sm">
                <Link to="/integrations/slack/install">
                  {t('team.integrations.slack.addAnother')}
                </Link>
              </Button>
            ) : (
              <AdminOnlyTooltip label={t('team.integrations.slack.adminOnly')}>
                <Button variant="outline" size="sm" type="button" disabled>
                  {t('team.integrations.slack.addAnother')}
                </Button>
              </AdminOnlyTooltip>
            )}
          </div>
        </>
      )}
    </SettingsSection>
  )
}

function DisconnectFailure({
  selected,
  code,
}: {
  selected: SlackConnectionListItem | null
  code: string
}) {
  const { t } = useT()
  return (
    <SettingsBanner kind="error">
      {selected && (
        <p>
          {t('team.integrations.slack.disconnectFailed', {
            name: selected.teamName,
          })}
        </p>
      )}
      <p>{t(settingsNotice(code).message)}</p>
    </SettingsBanner>
  )
}

function DisconnectDialog({
  selected,
  fetcher,
  close,
}: {
  selected: SlackConnectionListItem
  fetcher: ReturnType<typeof useFetcher<typeof action>>
  close: (open: boolean) => void
}) {
  const { t } = useT()
  const pending = fetcher.state !== 'idle'
  const result = pending ? undefined : fetcher.data
  return (
    <ConfirmActionDialog
      open
      awaitResult
      destructive
      pending={pending}
      returnFocusId={`disconnect-${selected.id}`}
      fallbackFocusId="slack-heading"
      onOpenChange={close}
      title={t('team.integrations.slack.disconnectTitle', {
        name: selected.teamName,
      })}
      description={t('team.integrations.slack.disconnectBody')}
      action={t(
        result && !result.ok
          ? 'dialog.retry'
          : 'team.integrations.slack.disconnect',
      )}
      pendingLabel={t('team.integrations.slack.disconnecting')}
      result={result && !result.ok && <StatusBanner status={result.code} />}
      onConfirm={() => {
        void fetcher.submit(
          { intent: 'disconnect-slack', connectionId: selected.id },
          { method: 'post' },
        )
      }}
    />
  )
}
