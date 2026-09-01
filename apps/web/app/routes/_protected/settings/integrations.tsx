import {
  IconAlertTriangle,
  IconCheck,
  IconPlug as Plug,
} from '@tabler/icons-react'
import type { ReactNode } from 'react'
import {
  Form,
  Link,
  redirect,
  useNavigation,
  useOutletContext,
  useSearchParams,
} from 'react-router'
import { SettingsPage } from '~/components/form/settings-page'
import { SettingsBanner } from './+components/settings-banner'
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
    return redirect('/settings/integrations?status=invalid')
  }

  const connectionId = stringValue(form.get('connectionId'))
  if (!connectionId) {
    return redirect('/settings/integrations?status=invalid')
  }

  const result = await deleteWorkspaceSlackConnection(
    createDb(),
    user,
    connectionId,
  )
  return redirect(`/settings/integrations?status=${result.kind}`)
}

export default function IntegrationsPage({ loaderData }: Route.ComponentProps) {
  const [searchParams] = useSearchParams()
  const showConnectedBanner = searchParams.get('connected') === 'slack'
  const { locale, t } = useT()
  const { connections } = loaderData
  const { currentUserIsAdmin } = useOutletContext<SettingsLayoutContext>()
  const navigation = useNavigation()
  const pendingDisconnectId =
    navigation.formAction === '/settings/integrations' &&
    navigation.formData?.get('intent') === 'disconnect-slack'
      ? stringValue(navigation.formData.get('connectionId'))
      : null

  return (
    <SettingsPage>
      {showConnectedBanner ? (
        <SettingsBanner
          role="status"
          className="border-success/30 bg-success-soft [&>svg]:text-success"
        >
          <IconCheck size={16} aria-hidden="true" />
          <span>{t('team.integrations.slack.connected')}</span>
        </SettingsBanner>
      ) : null}

      <SettingsSection
        title={t('team.integrations.slack.title')}
        description={t('team.integrations.slack.body')}
      >
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
}: {
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
                {t('team.integrations.slack.reauthorization.body')}
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
                <Button size="sm" type="button" disabled>
                  {t('team.integrations.slack.reauthorization.action')}
                </Button>
              </AdminOnlyTooltip>
            )
          ) : null}
          {canManage ? (
            <Form method="post" action="/settings/integrations">
              <input type="hidden" name="intent" value="disconnect-slack" />
              <input type="hidden" name="connectionId" value={connection.id} />
              <Button
                className="max-stack:w-full"
                variant="outline"
                size="sm"
                type="submit"
                disabled={pending}
              >
                {t('team.integrations.slack.disconnect')}
              </Button>
            </Form>
          ) : (
            <AdminOnlyTooltip label={adminOnly}>
              <Button variant="outline" size="sm" type="button" disabled>
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
