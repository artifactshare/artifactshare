import { useSettingsEntryChange } from '~/hooks/use-settings-entry-change'
import {
  useMemo,
  useState,
  useEffect,
  useRef,
  createContext,
  useContext,
} from 'react'
import {
  Form,
  data as actionData,
  useFetcher,
  useRevalidator,
  useOutletContext,
} from 'react-router'
import type { Route } from './+types/index'
import { NO_ASSET_TRANSFER } from '../+components/recipient-picker'
import { settingsFailure } from '~/lib/settings-submission'
import {
  confirmationResult,
  runConfirmedMutation,
} from '~/lib/settings-confirmation'
import { StatusBanner } from '../+components/settings-banner'
import { TeamActions } from '../+components/team-actions'
import {
  MemberConfirmation,
  isMemberConfirmation,
  type MemberTarget,
} from '../+components/member-confirmation'
import { Pager } from '~/components/form/pager'
import { TeamMuted, TeamMutedParagraph } from '~/components/form/team-muted'
import { TeamUser } from '../+components/team-user'
import { UpgradeNotice } from '../+components/upgrade-notice'
import type { SettingsLayoutContext } from '../_layout'
import { SettingsPage } from '~/components/form/settings-page'
import { SettingsSection } from '~/components/form/settings-section'
import { Badge } from '~/components/ui/badge'
import { Button } from '~/components/ui/button'
import { Field, FieldLabel } from '~/components/ui/field'
import { Input } from '~/components/ui/input'
import { IconButton } from '~/components/app/icon-button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '~/components/ui/dropdown-menu'
import { FilterSelect } from '../+components/filter-select'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '~/components/ui/table'
import { TableEmptyRow } from '~/components/form/table-empty-row'
import { useT } from '~/hooks/use-t'
import { formatRelative } from '~/lib/datetime'
import { stringValue } from '~/lib/form'
import {
  displayName,
  MEMBERS_PAGE_SIZE,
  type MembersPageFilters,
  type TeamContributor,
  type TeamMember,
  type TeamMutationResult,
  type RemovedTeamMember,
  type WorkspaceMemberRole,
} from '~/lib/team-management'
import { requireUser } from '~/middleware/context'
import { createDb } from '~/services/db.server'
import { settingsActiveAdmin } from '../+lib/settings-request.server'
import {
  grantWorkspaceAdmin,
  loadRemovedWorkspaceMembers,
  loadWorkspaceMembersPage,
  parseMembersPageFilters,
  isRemovedWorkspaceMember,
  removeWorkspaceMember,
  restoreWorkspaceMember,
  revokeWorkspaceAdmin,
  revokeWorkspaceMemberCliSessions,
  transferRemovedMemberAssets,
  transferWorkspaceOwner,
} from '~/services/team-management.server'
import { IconDots } from '@tabler/icons-react'
export async function loader({ request, context }: Route.LoaderArgs) {
  const user = requireUser(context)
  const filters = parseMembersPageFilters(new URL(request.url).searchParams)
  const db = createDb()
  // The role shown on the page comes from the Settings shell. Removed members
  // are still authorized here, on the request's own active membership.
  const [membersPage, admin] = await Promise.all([
    loadWorkspaceMembersPage(db, user.workspaceId, filters),
    settingsActiveAdmin(context, request),
  ])
  const removedMembers = admin
    ? await loadRemovedWorkspaceMembers(db, user.workspaceId)
    : []
  return { membersPage, removedMembers, filters }
}

export async function action({ request, context }: Route.ActionArgs) {
  const form = await request.formData()
  const intent = stringValue(form.get('intent')) ?? ''
  return runConfirmedMutation(async () => {
    const user = requireUser(context)

    const db = createDb()
    let result: TeamMutationResult
    switch (intent) {
      case 'transfer-owner': {
        const userId = stringValue(form.get('userId'))
        if (!userId) return settingsFailure(intent, 'invalid')
        result = await transferWorkspaceOwner(db, user, userId)
        break
      }
      case 'grant-admin': {
        const userId = stringValue(form.get('userId'))
        if (!userId) return settingsFailure(intent, 'invalid')
        result = await grantWorkspaceAdmin(db, user, userId)
        break
      }
      case 'revoke-admin': {
        const userId = stringValue(form.get('userId'))
        if (!userId) return settingsFailure(intent, 'invalid')
        result = await revokeWorkspaceAdmin(db, user, userId)
        break
      }
      case 'revoke-cli-sessions': {
        const userId = stringValue(form.get('userId'))
        if (!userId) return settingsFailure(intent, 'invalid')
        result = await revokeWorkspaceMemberCliSessions(db, user, userId)
        break
      }
      case 'remove-member': {
        const userId = stringValue(form.get('userId'))
        if (!userId) return settingsFailure(intent, 'invalid')
        result = await removeWorkspaceMember(db, user, userId)
        // A retry after a lost response finds the member already removed.
        // The first request committed the removal, so finish the transfer.
        if (
          result.kind === 'not-found' &&
          (await isRemovedWorkspaceMember(db, user.workspaceId, userId))
        ) {
          result = { kind: 'ok' }
        }
        if (result.kind === 'ok') {
          const recipientUserId = stringValue(form.get('recipientUserId'))
          if (recipientUserId && recipientUserId !== NO_ASSET_TRANSFER) {
            const transferResult = await transferRemovedMemberAssets(
              db,
              user,
              userId,
              recipientUserId,
            )
            if (transferResult.kind !== 'ok') {
              return actionData(
                {
                  ok: false as const,
                  code: 'removed-transfer-failed',
                  intent,
                  removalCommitted: true,
                },
                { status: 409 },
              )
            }
          }
          return actionData(
            { ok: true as const, code: 'removed', intent },
            { status: 200 },
          )
        }
        break
      }
      case 'transfer-removed-assets': {
        const userId = stringValue(form.get('userId'))
        const recipientUserId = stringValue(form.get('recipientUserId'))
        if (
          !userId ||
          !recipientUserId ||
          recipientUserId === NO_ASSET_TRANSFER
        ) {
          return settingsFailure(intent, 'invalid')
        }
        result = await transferRemovedMemberAssets(
          db,
          user,
          userId,
          recipientUserId,
        )
        break
      }
      case 'restore-member': {
        const userId = stringValue(form.get('userId'))
        if (!userId) return settingsFailure(intent, 'invalid')
        result = await restoreWorkspaceMember(db, user, userId)
        if (result.kind === 'not-found') {
          return settingsFailure(intent, 'restore-unavailable')
        }
        break
      }
      default:
        return settingsFailure(intent, 'invalid')
    }

    return result.kind === 'ok'
      ? actionData({ ok: true as const, code: 'ok', intent }, { status: 200 })
      : settingsFailure(intent, result.kind)
  })
}

export async function clientAction({
  request,
  serverAction,
}: Route.ClientActionArgs) {
  const intent =
    stringValue((await request.clone().formData()).get('intent')) ?? ''
  return isMemberConfirmation(intent)
    ? confirmationResult(intent, serverAction)
    : serverAction()
}

const MemberActions = createContext<{
  open: (target: MemberTarget) => void
  pendingId?: string
} | null>(null)

export default function TeamMembersPage({
  loaderData,
}: Pick<Route.ComponentProps, 'loaderData'>) {
  const shell = useOutletContext<SettingsLayoutContext>()
  const isUpgrade = shell.kind === 'upgrade'
  const canManage = shell.currentUserIsAdmin

  const [target, setTarget] = useState<MemberTarget | null>(null)
  const fetcher = useFetcher<typeof action>()
  useSettingsEntryChange(fetcher.reset)
  const { reset } = fetcher
  const { revalidate } = useRevalidator()
  const result = fetcher.state === 'idle' ? fetcher.data : undefined
  const consumed = useRef<typeof result>(undefined)
  useEffect(() => {
    if (!result || consumed.current === result) return
    consumed.current = result
    if (result.ok) setTarget(null)
    else if ('removalCommitted' in result && result.removalCommitted)
      void revalidate()
  }, [result, revalidate])
  const pendingId = fetcher.state !== 'idle' ? target?.member.id : undefined
  const controls = useMemo(
    () => ({
      open: (next: MemberTarget) => {
        reset()
        setTarget(next)
      },
      pendingId,
    }),
    [reset, pendingId],
  )
  return (
    <MemberActions.Provider value={controls}>
      <SettingsPage>
        {result?.ok && <StatusBanner status={result.code} />}
        {target && (
          <MemberConfirmation
            target={target}
            currentUser={shell.user}
            close={() => setTarget(null)}
            fetcher={fetcher}
          />
        )}
        <MemberSection
          members={loaderData.membersPage.members}
          total={loaderData.membersPage.total}
          page={loaderData.membersPage.page}
          filters={loaderData.filters}
          currentUser={shell.user}
          canManage={canManage}
          currentUserRole={shell.currentUserRole}
        />

        {canManage ? (
          <RemovedMemberSection
            members={loaderData.removedMembers}
            canManage={canManage}
          />
        ) : null}

        {isUpgrade ? (
          <UpgradeNotice titleKey="team.upgrade" isAdmin={canManage} />
        ) : null}
      </SettingsPage>
    </MemberActions.Provider>
  )
}

function membersPageSearch(filters: MembersPageFilters, page: number): string {
  const params = new URLSearchParams()
  if (filters.query) params.set('q', filters.query)
  if (filters.role !== 'all') params.set('role', filters.role)
  if (filters.activity !== 'all') params.set('activity', filters.activity)
  if (page > 1) params.set('page', String(page))
  const qs = params.toString()
  return qs ? `/settings?${qs}` : '/settings'
}

function MemberSection({
  members,
  total,
  page,
  filters,
  currentUser,
  canManage,
  currentUserRole,
}: {
  members: TeamContributor[]
  total: number
  page: number
  filters: MembersPageFilters
  currentUser: TeamMember
  canManage: boolean
  currentUserRole: WorkspaceMemberRole
}) {
  const { t } = useT()
  const filtered =
    filters.query !== '' || filters.role !== 'all' || filters.activity !== 'all'
  // back/forward で filters が変わったとき、key で入力欄を作り直して表示と同期する。
  const filterKey = `${filters.query}|${filters.role}|${filters.activity}`
  return (
    <SettingsSection
      title={t('team.members')}
      description={t('team.members.body')}
      guidanceId="members-guidance"
      readOnlyGuidance={
        currentUserRole === 'owner'
          ? undefined
          : canManage
            ? t('team.members.ownerActions')
            : [
                t('team.members.managerActions'),
                t('team.members.ownerActions'),
              ].join(' ')
      }
    >
      <Form
        key={filterKey}
        method="get"
        action="/settings"
        className="flex flex-wrap items-end gap-[var(--spacing-2)]"
      >
        <Field className="min-w-0 flex-1 basis-48">
          <FieldLabel htmlFor="member-search" className="sr-only">
            {t('team.members.search.label')}
          </FieldLabel>
          <Input
            id="member-search"
            name="q"
            type="search"
            defaultValue={filters.query}
            placeholder={t('team.members.search.placeholder')}
          />
        </Field>
        <FilterSelect
          id="member-role-filter"
          name="role"
          label={t('team.members.filter.role')}
          initialValue={filters.role}
          className="w-36"
          options={{
            all: t('team.members.filter.role.all'),
            owner: t('team.members.role.owner'),
            admin: t('team.members.role.admin'),
            member: t('team.members.role.member'),
          }}
        />
        <FilterSelect
          id="member-activity-filter"
          name="activity"
          label={t('team.members.filter.activity')}
          initialValue={filters.activity}
          className="w-36"
          options={{
            all: t('team.members.filter.activity.all'),
            active: t('team.members.filter.activity.active'),
            inactive: t('team.members.filter.activity.inactive'),
          }}
        />
        <Button type="submit" variant="outline" size="sm">
          {t('team.members.filter.apply')}
        </Button>
      </Form>

      <Table>
        <TableHeader className="hidden md:table-header-group">
          <TableRow>
            <TableHead>{t('team.members.user')}</TableHead>
            <TableHead className="max-phone:hidden">
              {t('team.members.lastUpload')}
            </TableHead>
            <TableHead className="text-right">
              {t('team.members.actions')}
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {members.map((member) => (
            <MemberRow
              key={member.id}
              member={member}
              currentUser={currentUser}
              canManage={canManage}
              currentUserRole={currentUserRole}
            />
          ))}
          {members.length === 0 ? (
            <TableEmptyRow colSpan={3}>
              {filtered ? t('team.members.noMatches') : t('team.members.empty')}
            </TableEmptyRow>
          ) : null}
        </TableBody>
      </Table>

      <Pager
        page={page}
        total={total}
        pageSize={MEMBERS_PAGE_SIZE}
        hrefFor={(nextPage) => membersPageSearch(filters, nextPage)}
        labels={{
          range: 'team.members.range',
          prev: 'team.members.page.prev',
          next: 'team.members.page.next',
        }}
      />
    </SettingsSection>
  )
}

function MemberRow({
  member,
  currentUser,
  canManage,
  currentUserRole,
}: {
  member: TeamContributor
  currentUser: TeamMember
  canManage: boolean
  currentUserRole: WorkspaceMemberRole
}) {
  const currentUserId = currentUser.id
  const { locale, t } = useT()
  const actions = useContext(MemberActions)
  const triggerId = `member-menu-${member.id}`
  const open = (intent: MemberTarget['intent']) =>
    actions?.open({ intent, member, triggerId })
  const {
    isOwner,
    isAdmin,
    canManageRoles,
    eligibleForTransfer,
    eligibleForRemove,
    eligibleForCliRevoke,
  } = memberPermissions(member, currentUserId, canManage, currentUserRole)

  return (
    <TableRow className="flex min-w-0 flex-col md:table-row">
      <TableCell className="min-w-0 max-md:w-full max-md:whitespace-normal">
        <div className="flex min-w-0 flex-col items-start gap-[var(--spacing-2)] md:flex-row md:items-center">
          <TeamUser
            name={displayName(member)}
            email={member.email}
            wrapOnPhone
          />
          {isOwner ? (
            <Badge variant="default">{t('team.members.role.owner')}</Badge>
          ) : null}
          {isAdmin ? (
            <Badge variant="default">{t('team.members.role.admin')}</Badge>
          ) : null}
        </div>
      </TableCell>
      <TableCell className="max-phone:hidden">
        <TeamMuted>
          <span className="md:hidden">{t('team.members.lastUpload')}: </span>
          {member.lastContributedAt
            ? formatRelative(member.lastContributedAt, locale)
            : '—'}
        </TeamMuted>
      </TableCell>
      <TableCell>
        <TeamActions>
          <MemberActionsMenu
            permissions={{
              eligibleForTransfer,
              eligibleForRemove,
              eligibleForCliRevoke,
              canManageRoles,
            }}
            member={member}
            pendingForMember={actions?.pendingId === member.id}
            triggerId={triggerId}
            onRoleChange={() =>
              open(member.role === 'admin' ? 'revoke-admin' : 'grant-admin')
            }
            onRemove={() => open('remove-member')}
            onTransfer={() => open('transfer-owner')}
            onRevokeCli={() => open('revoke-cli-sessions')}
          />
        </TeamActions>
      </TableCell>
    </TableRow>
  )
}

function RemovedMemberSection({
  members,
  canManage,
}: {
  members: RemovedTeamMember[]
  canManage: boolean
}) {
  const { t } = useT()

  return (
    <SettingsSection
      id="removed-members"
      title={t('team.removedMembers')}
      description={t('team.removedMembers.body')}
    >
      {members.length === 0 ? (
        <TeamMutedParagraph data-removed-empty>
          {t('team.removedMembers.empty')}
        </TeamMutedParagraph>
      ) : (
        <Table>
          <TableHeader className="hidden md:table-header-group">
            <TableRow>
              <TableHead>{t('team.members.user')}</TableHead>
              <TableHead>{t('team.removedMembers.artifacts')}</TableHead>
              <TableHead className="text-right">
                {t('team.members.actions')}
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {members.map((member) => (
              <RemovedMemberRow
                key={member.id}
                member={member}
                canManage={canManage}
              />
            ))}
          </TableBody>
        </Table>
      )}
    </SettingsSection>
  )
}

function RemovedMemberRow({
  member,
  canManage,
}: {
  member: RemovedTeamMember
  canManage: boolean
}) {
  const { t } = useT()
  const actions = useContext(MemberActions)
  const pendingForMember = actions?.pendingId === member.id
  return (
    <TableRow className="flex min-w-0 flex-col md:table-row">
      <TableCell className="min-w-0 max-md:w-full max-md:whitespace-normal">
        <TeamUser name={displayName(member)} email={member.email} wrapOnPhone />
      </TableCell>
      <TableCell>
        <TeamMuted data-owned-file-count={member.ownedArtifactCount}>
          <span className="md:hidden">
            {t('team.removedMembers.artifacts')}:{' '}
          </span>
          {member.ownedArtifactCount}
        </TeamMuted>
      </TableCell>
      <TableCell>
        <TeamActions>
          <Button
            variant="outline"
            size="sm"
            type="button"
            disabled={
              !canManage || member.ownedArtifactCount === 0 || pendingForMember
            }
            data-transfer-removed-files
            id={`transfer-removed-assets-${member.id}`}
            onClick={() =>
              actions?.open({
                intent: 'transfer-removed-assets',
                member,
                triggerId: `transfer-removed-assets-${member.id}`,
              })
            }
          >
            {t('team.removedMembers.transfer')}
          </Button>
          <Button
            variant="outline"
            size="sm"
            type="button"
            disabled={!canManage || pendingForMember}
            id={`restore-member-${member.id}`}
            onClick={() =>
              actions?.open({
                intent: 'restore-member',
                member,
                triggerId: `restore-member-${member.id}`,
              })
            }
          >
            {t('team.removedMembers.restore')}
          </Button>
        </TeamActions>
      </TableCell>
    </TableRow>
  )
}

function memberPermissions(
  member: TeamContributor,
  currentUserId: string,
  canManage: boolean,
  currentUserRole: WorkspaceMemberRole,
) {
  const isSelf = member.id === currentUserId
  const isOwner = member.role === 'owner'
  const isAdmin = member.role === 'admin'
  const canManageRoles =
    canManage &&
    currentUserRole === 'owner' &&
    !isSelf &&
    member.role !== 'owner'
  const eligibleForTransfer = canManageRoles
  const eligibleForRemove = canManage && !isOwner && !isAdmin && !isSelf
  const eligibleForCliRevoke = canManage && member.role === 'member'
  return {
    isOwner,
    isAdmin,
    canManageRoles,
    eligibleForTransfer,
    eligibleForRemove,
    eligibleForCliRevoke,
  }
}

function MemberActionsMenu({
  permissions,
  member,
  pendingForMember,
  triggerId,
  onRoleChange,
  onTransfer,
  onRevokeCli,
  onRemove,
}: {
  permissions: Pick<
    ReturnType<typeof memberPermissions>,
    | 'eligibleForTransfer'
    | 'eligibleForRemove'
    | 'eligibleForCliRevoke'
    | 'canManageRoles'
  >
  member: TeamContributor
  pendingForMember: boolean
  triggerId: string
  onRoleChange: () => void
  onTransfer: () => void
  onRevokeCli: () => void
  onRemove: () => void
}) {
  const { t } = useT()
  const {
    eligibleForTransfer,
    eligibleForRemove,
    eligibleForCliRevoke,
    canManageRoles,
  } = permissions
  if (!eligibleForTransfer && !eligibleForRemove && !eligibleForCliRevoke)
    return null
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <IconButton
          type="button"
          id={triggerId}
          icon={IconDots}
          size="md"
          disabled={pendingForMember}
          aria-label={t('team.members.menu')}
        />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {canManageRoles && member.role === 'member' ? (
          <DropdownMenuItem onSelect={onRoleChange}>
            {t('team.members.makeAdmin')}
          </DropdownMenuItem>
        ) : null}
        {canManageRoles && member.role === 'admin' ? (
          <DropdownMenuItem onSelect={onRoleChange}>
            {t('team.members.removeAdmin')}
          </DropdownMenuItem>
        ) : null}
        {canManageRoles ? (
          <DropdownMenuItem onSelect={onTransfer}>
            {t('team.members.transferOwner')}
          </DropdownMenuItem>
        ) : null}
        {eligibleForCliRevoke ? (
          <DropdownMenuItem
            data-member-action="revoke-cli-sessions"
            onSelect={onRevokeCli}
          >
            {t('team.members.revokeCliSessions')}
          </DropdownMenuItem>
        ) : null}
        {canManageRoles && eligibleForRemove ? <DropdownMenuSeparator /> : null}
        {eligibleForRemove ? (
          <DropdownMenuItem
            data-member-action="remove-member"
            variant="destructive"
            onSelect={onRemove}
          >
            {t('team.members.remove')}
          </DropdownMenuItem>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
