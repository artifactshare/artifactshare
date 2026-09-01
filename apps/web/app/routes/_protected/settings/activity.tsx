import { redirect } from 'react-router'
import type { Route } from './+types/activity'
import { TableEmptyRow } from '~/components/form/table-empty-row'
import { SettingsPage } from '~/components/form/settings-page'
import { SettingsSection } from '~/components/form/settings-section'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '~/components/ui/table'
import { Pager } from '~/components/form/pager'
import { BotBadge, UserKindBadge } from '~/components/app/user-kind-badge'
import { useT } from '~/hooks/use-t'
import { formatRelative } from '~/lib/datetime'
import {
  displayName,
  AUDIT_EVENTS_PAGE_SIZE,
  type AuditEventEntry,
} from '~/lib/team-management'
import { requireUser } from '~/middleware/context'
import { createDb } from '~/services/db.server'
import { workspaceAdminQuery } from '~/services/access.server'
import { loadAuditEventsPage } from '~/services/team-management.server'
import { parsePageParam } from '~/lib/pagination'
import type { TKey } from '~/i18n/messages'
import { truncateCellClassName } from '~/components/form/settings-text-styles'

function activityPageLink(page: number): string {
  return `/settings/activity?page=${page}`
}

export async function loader({ request, context }: Route.LoaderArgs) {
  const user = requireUser(context)
  const db = createDb()
  const admin = await workspaceAdminQuery(
    db,
    user.id,
    user.workspaceId,
  ).executeTakeFirst()
  if (!admin) throw redirect('/settings')
  return loadAuditEventsPage(
    db,
    user.workspaceId,
    parsePageParam(new URL(request.url).searchParams),
  )
}

export default function ActivityPage({ loaderData }: Route.ComponentProps) {
  const { t, locale } = useT()
  const { events, total, page } = loaderData
  return (
    <SettingsPage>
      <SettingsSection
        title={t('team.activity.title')}
        description={t('team.activity.body')}
      >
        <Table>
          <TableHeader className="max-wide:hidden">
            <TableRow>
              <TableHead>{t('team.activity.actionHeader')}</TableHead>
              <TableHead>{t('team.activity.subject')}</TableHead>
              <TableHead>{t('team.activity.actor')}</TableHead>
              <TableHead>{t('team.activity.time')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {events.map((event) => (
              <ActivityRow key={event.id} event={event} locale={locale} />
            ))}
            {events.length === 0 ? (
              <TableEmptyRow colSpan={4}>
                {t('team.activity.empty')}
              </TableEmptyRow>
            ) : null}
          </TableBody>
        </Table>
        <Pager
          page={page}
          total={total}
          pageSize={AUDIT_EVENTS_PAGE_SIZE}
          hrefFor={(nextPage) =>
            nextPage > 1 ? activityPageLink(nextPage) : '/settings/activity'
          }
          labels={{
            range: 'team.activity.range',
            prev: 'team.activity.page.prev',
            next: 'team.activity.page.next',
          }}
        />
      </SettingsSection>
    </SettingsPage>
  )
}

function ActivityRow({
  event,
  locale,
}: {
  event: AuditEventEntry
  locale: 'ja' | 'en'
}) {
  const { t } = useT()
  const action = actionText(event, t)
  const subject = subjectText(event, t)
  const subjectIsBot =
    event.subject?.kind === 'bot' || event.action.startsWith('bot.')
  const notificationEvent =
    event.action.startsWith('access_request.email.') ||
    event.action.startsWith('access_request.slack.')
  const subjectNode = subject ? (
    <span className="inline-flex min-w-0 flex-wrap items-center gap-[var(--spacing-1)] break-words">
      {subject}
      {subjectIsBot ? <BotBadge /> : null}
    </span>
  ) : (
    '—'
  )
  const actorNode = event.actor ? (
    <span className="inline-flex min-w-0 flex-wrap items-center gap-[var(--spacing-1)] break-words">
      {actorText(event)}
      <UserKindBadge kind={event.actor.kind} />
    </span>
  ) : notificationEvent ? (
    t('team.activity.system')
  ) : (
    '—'
  )
  const actorTitle = event.actor
    ? actorText(event)
    : notificationEvent
      ? t('team.activity.system')
      : '—'
  const values = [
    [t('team.activity.actionHeader'), action],
    [t('team.activity.subject'), subjectNode],
    [t('team.activity.actor'), actorNode],
    [t('team.activity.time'), formatRelative(event.createdAt, locale)],
  ] as const
  return (
    <TableRow>
      <TableCell className="max-wide:hidden">{action}</TableCell>
      <TableCell className="max-wide:hidden max-w-96 break-words whitespace-normal">
        {subjectNode}
      </TableCell>
      <TableCell className="max-wide:hidden">
        <span className={truncateCellClassName} title={actorTitle}>
          {actorNode}
        </span>
      </TableCell>
      <TableCell className="max-wide:hidden">
        {formatRelative(event.createdAt, locale)}
      </TableCell>
      <TableCell
        className="max-wide:table-cell max-wide:whitespace-normal hidden"
        colSpan={4}
      >
        <dl className="grid gap-2">
          {values.map(([label, value]) => (
            <div
              key={label}
              className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1"
            >
              <dt className="text-muted-foreground font-medium">{label}</dt>
              <dd className="min-w-0 break-words">{value}</dd>
            </div>
          ))}
        </dl>
      </TableCell>
    </TableRow>
  )
}

const ACTIONS = {
  'member.remove': true,
  'member.restore': true,
  'admin.grant': true,
  'admin.revoke': true,
  'owner.transfer': true,
  'assets.transfer': true,
  'plan.change': true,
  'artifact.delete': true,
  'cli.refresh_credential.revoke': true,
  'bot.create': true,
  'bot.stop': true,
  'bot.credential.reissue': true,
  'access_request.created': true,
  'access_request.email.attempting': true,
  'access_request.email.succeeded': true,
  'access_request.email.failed': true,
  'access_request.email.unknown': true,
  'access_request.slack.attempting': true,
  'access_request.slack.succeeded': true,
  'access_request.slack.failed': true,
  'access_request.slack.unknown': true,
  'access_request.approved': true,
  'access_request.rejected': true,
} as const

const NOTIFICATION_OUTCOME_WINDOW_MS = 15 * 60 * 1000

function actionText(
  event: AuditEventEntry,
  t: (key: TKey, vars?: Record<string, string | number>) => string,
): string {
  let action = event.action
  if (
    action.endsWith('.attempting') &&
    Date.now() - Date.parse(event.createdAt) >= NOTIFICATION_OUTCOME_WINDOW_MS
  ) {
    action = action.replace(/\.attempting$/u, '.unknown')
  }
  const actionKey = `team.activity.action.${action}` as TKey
  return action in ACTIONS ? t(actionKey) : action
}

function actorText(event: AuditEventEntry): string {
  if (!event.actor) return '—'
  if (!event.action.startsWith('access_request.')) {
    return displayName(event.actor)
  }
  return [event.actor.name?.trim(), event.actor.email]
    .filter(
      (value, index, values) =>
        Boolean(value) && values.indexOf(value) === index,
    )
    .join(' · ')
}

function subjectText(
  event: AuditEventEntry,
  t: (key: TKey, vars?: Record<string, string | number>) => string,
): string {
  const d = event.detail
  const user = event.subject ? displayName(event.subject) : null
  switch (event.action) {
    case 'member.remove':
    case 'member.restore':
      return [d.name, d.email].filter(Boolean).join(' · ')
    case 'admin.grant':
    case 'admin.revoke':
      return [
        user,
        d.fromRole && d.toRole
          ? `${roleText(d.fromRole, t)} → ${roleText(d.toRole, t)}`
          : null,
      ]
        .filter(Boolean)
        .join(' · ')
    case 'cli.refresh_credential.revoke':
      return user ?? t('team.tokens.cli.session')
    case 'owner.transfer':
      return user ?? ''
    case 'assets.transfer':
      return [
        user,
        d.recipientEmail,
        d.artifactCount == null
          ? null
          : t('team.activity.artifactCount', { count: d.artifactCount }),
      ]
        .filter(Boolean)
        .join(' · ')
    case 'plan.change':
      return [d.from, d.to]
        .filter((plan): plan is string => Boolean(plan))
        .map((plan) => planText(plan, t))
        .join(' → ')
    case 'artifact.delete':
      return d.name ?? ''
    case 'bot.create':
    case 'bot.stop':
    case 'bot.credential.reissue':
      // Subject shows the bot's display name; the shared bot badge marks it
      // in the cell. Token, hash, and generated email never enter details.
      return d.name ?? user ?? ''
    case 'access_request.created':
      return accessRequestDetails(event, t, [
        requesterText(event),
        d.handlerEmail
          ? t('team.activity.accessRequest.handler', {
              email: d.handlerEmail,
            })
          : null,
      ])
    case 'access_request.email.attempting':
    case 'access_request.email.succeeded':
    case 'access_request.email.failed':
    case 'access_request.slack.attempting':
    case 'access_request.slack.succeeded':
    case 'access_request.slack.failed':
      return accessRequestDetails(event, t, [d.recipientEmail])
    case 'access_request.approved':
      return accessRequestDetails(event, t, [
        requesterText(event),
        d.resolutionScope
          ? t(
              d.resolutionScope === 'project'
                ? 'team.activity.accessRequest.scope.project'
                : 'team.activity.accessRequest.scope.artifact',
            )
          : null,
      ])
    case 'access_request.rejected':
      return accessRequestDetails(event, t, [requesterText(event)])
    default:
      return ''
  }
}

function accessRequestDetails(
  event: AuditEventEntry,
  t: (key: TKey, vars?: Record<string, string | number>) => string,
  values: Array<string | null | undefined>,
): string {
  const d = event.detail
  const requestId = d.accessRequestId
    ? t('team.activity.accessRequest.id', {
        id: d.accessRequestId.slice(0, 8),
      })
    : null
  const project = d.projectName
    ? t('team.activity.accessRequest.project', { project: d.projectName })
    : null
  return [d.artifactTitle, project, ...values, requestId]
    .filter(Boolean)
    .join(' · ')
}

function requesterText(event: AuditEventEntry): string | null {
  const { requesterName, requesterEmail } = event.detail
  if (!requesterName) return requesterEmail ?? null
  return requesterEmail ? `${requesterName} (${requesterEmail})` : requesterName
}

function roleText(role: string, t: (key: TKey) => string): string {
  const labels: Record<string, string> = {
    owner: 'team.members.role.owner',
    admin: 'team.members.role.admin',
    member: 'team.members.role.member',
  }
  return labels[role] ? t(labels[role] as TKey) : role
}

function planText(plan: string, t: (key: TKey) => string): string {
  const labels: Record<string, string> = {
    free: 'billing.plan.free',
    plus: 'billing.plan.plus',
    team: 'billing.plan.team',
  }
  return labels[plan] ? t(labels[plan] as TKey) : plan
}
