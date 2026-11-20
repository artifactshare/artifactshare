import { IconAlertTriangle, IconPlug as Plug } from '@tabler/icons-react'
import { useState, type ReactNode } from 'react'
import {
  useSubmit,
  useActionData,
  Link,
  redirect,
  useNavigation,
  useOutletContext,
  useSearchParams,
} from 'react-router'
import { SettingsPage } from '~/components/form/settings-page'
import { ConfirmActionDialog } from './+components/confirm-action-dialog'
import {
  SettingsBanner,
  StatusBanner,
  settingsNotice,
} from './+components/settings-banner'
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
import type { SettingsLayoutContext } from './_layout'
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
          data: {
            error: 'external-failed',
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
        scenario: 'settings-integrations/slack-disconnected',
        reseedBeforeCapture: true,
        query: '?status=slack-disconnected',
        ready: {
          selector: '[role="status"]:has-text("disconnected")',
          description: 'Explicit disconnected notice',
        },
      },
    },
    {
      id: 'slack-disconnect-page-error',
      description: 'Slack failure remains visible after dismissing the dialog',
      setup: {
        scenario: 'settings-integrations/slack-connected',
        reseedBeforeCapture: true,
        actionResponse: {
          route: '/settings/integrations',
          method: 'POST',
          intent: 'disconnect-slack',
          data: {
            error: 'external-failed',
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
          {
            action: 'click',
            selector: '[role="alertdialog"] button:text-is("Cancel")',
            readySelector:
              'body:not(:has([role="alertdialog"])) [role="alert"]',
          },
        ],
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

export async function loader({ context }: Route.LoaderArgs) {
  const user = requireUser(context)
  const connections = await listWorkspaceSlackConnections(
    createDb(),
    user.workspaceId,
  )
  return { connections }
}

export async function action({ request, context }: Route.ActionArgs) {
  const user = requireUser(context)
  const form = await request.formData()
  const intent = stringValue(form.get('intent'))
  if (intent !== 'disconnect-slack') {
    return { error: 'invalid' as const }
  }

  const connectionId = stringValue(form.get('connectionId'))
  if (!connectionId) {
    return { error: 'invalid' as const }
  }

  const result = await deleteWorkspaceSlackConnection(
    createDb(),
    user,
    connectionId,
  )
  if (result.kind !== 'ok') return { error: result.kind, connectionId }
  return redirect('/settings/integrations?status=slack-disconnected')
}

export default function IntegrationsPage({
  loaderData,
}: Pick<Route.ComponentProps, 'loaderData'>) {
  const [searchParams] = useSearchParams()
  const actionData = useActionData<typeof action>()
  const [openConnectionId, setOpenConnectionId] = useState<string | null>(null)
  const [selectedConnection, setSelectedConnection] =
    useState<SlackConnectionListItem | null>(null)
  const showConnectedBanner = searchParams.get('connected') === 'slack'
  const { locale, t } = useT()
  const { connections } = loaderData
  const { currentUserIsAdmin } = useOutletContext<SettingsLayoutContext>()
  const navigation = useNavigation()
  const pending = navigation.state !== 'idle'
  const pendingDisconnectId =
    navigation.formAction === '/settings/integrations' &&
    navigation.formData?.get('intent') === 'disconnect-slack'
      ? stringValue(navigation.formData.get('connectionId'))
      : null
  const submittedConnection =
    selectedConnection?.id === actionData?.connectionId
      ? selectedConnection
      : connections.find(
          (connection) => connection.id === actionData?.connectionId,
        )
  const dialogRendered =
    currentUserIsAdmin &&
    connections.some((connection) => connection.id === openConnectionId)

  return (
    <SettingsPage>
      {actionData?.error && !pending && !dialogRendered ? (
        <SettingsBanner kind="error">
          {submittedConnection ? (
            <p>
              {t('team.integrations.slack.disconnectFailed', {
                name: submittedConnection.teamName,
              })}
            </p>
          ) : null}
          <p>{t(settingsNotice(actionData.error).message)}</p>
        </SettingsBanner>
      ) : null}
      {showConnectedBanner ? (
        <SettingsBanner kind="success">
          <span>{t('team.integrations.slack.connected')}</span>
        </SettingsBanner>
      ) : null}

      <SettingsSection
        title={t('team.integrations.slack.title')}
        description={t('team.integrations.slack.body')}
      >
        {!currentUserIsAdmin ? (
          <p className="text-muted-foreground text-sm">
            {t('team.integrations.slack.memberGuidance')}
          </p>
        ) : null}
        {connections.length === 0 ? (
          <Empty>
            <EmptyHeader>
              <EmptyDescription>
                {t('team.integrations.slack.empty')}
              </EmptyDescription>
            </EmptyHeader>
            <EmptyContent>
              {currentUserIsAdmin ? (
                <Button asChild size="sm">
                  <Link to="/integrations/slack/install">
                    {t('team.integrations.slack.connect')}
                  </Link>
                </Button>
              ) : (
                <AdminOnlyTooltip
                  label={t('team.integrations.slack.adminOnly')}
                >
                  <Button size="sm" type="button" disabled>
                    {t('team.integrations.slack.connect')}
                  </Button>
                </AdminOnlyTooltip>
              )}
            </EmptyContent>
          </Empty>
        ) : (
          <>
            <Stack gap="3">
              {connections.map((connection) => (
                <SlackConnectionCard
                  key={connection.id}
                  connection={connection}
                  locale={locale}
                  canManage={currentUserIsAdmin}
                  pending={pendingDisconnectId === connection.id}
                  onDisconnectOpenChange={(open) => {
                    if (open) setSelectedConnection(connection)
                    setOpenConnectionId(open ? connection.id : null)
                  }}
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
                <AdminOnlyTooltip
                  label={t('team.integrations.slack.adminOnly')}
                >
                  <Button variant="outline" size="sm" type="button" disabled>
                    {t('team.integrations.slack.addAnother')}
                  </Button>
                </AdminOnlyTooltip>
              )}
            </div>
          </>
        )}
      </SettingsSection>
    </SettingsPage>
  )
}

export function SlackConnectionCard({
  connection,
  locale,
  canManage,
  pending,
  onDisconnectOpenChange,
}: {
  onDisconnectOpenChange?: (open: boolean) => void
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
              <p className="text-muted-foreground text-sm">
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
            <SlackDisconnectDialog
              connection={connection}
              pending={pending}
              onOpenChange={onDisconnectOpenChange}
            />
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

function SlackDisconnectDialog({
  connection,
  pending: navigationPending,
  onOpenChange,
}: {
  onOpenChange?: (open: boolean) => void
  connection: SlackConnectionListItem
  pending: boolean
}) {
  const { t } = useT()
  const [dialogState, setDialogState] = useState<
    'closed' | 'confirming' | 'submitted'
  >('closed')
  const submit = useSubmit()
  const actionData = useActionData<typeof action>()
  const navigation = useNavigation()
  const [searchParams] = useSearchParams()
  const status = searchParams.get('status')
  const pending = navigationPending || navigation.state !== 'idle'
  const completed = dialogState === 'submitted' && !pending
  const error = completed ? actionData?.error : undefined
  const disconnectOpen =
    dialogState !== 'closed' &&
    !(completed && !error && status === 'slack-disconnected')
  return (
    <ConfirmActionDialog
      open={disconnectOpen}
      onOpenChange={(open) => {
        setDialogState(open ? 'confirming' : 'closed')
        onOpenChange?.(open)
      }}
      destructive
      awaitResult
      pending={pending}
      title={t('team.integrations.slack.disconnectTitle', {
        name: connection.teamName,
      })}
      description={t('team.integrations.slack.disconnectBody')}
      action={t('team.integrations.slack.disconnect')}
      pendingLabel={t('team.integrations.slack.disconnecting')}
      result={error ? <StatusBanner status={error} /> : undefined}
      onConfirm={() => {
        setDialogState('submitted')
        void submit(
          { intent: 'disconnect-slack', connectionId: connection.id },
          { method: 'post', action: '/settings/integrations' },
        )
      }}
      trigger={
        <Button
          className="max-stack:w-full"
          variant="outline"
          size="sm"
          type="button"
          disabled={pending}
        >
          {t('team.integrations.slack.disconnect')}
        </Button>
      }
    />
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
