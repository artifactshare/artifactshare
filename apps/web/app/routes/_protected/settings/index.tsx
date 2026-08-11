import { useState } from 'react'
import { Form, redirect, useNavigation, useOutletContext } from 'react-router'
import type { Route } from './+types/index'
import {
  NO_ASSET_TRANSFER,
  RemoveMemberDialog,
} from './+components/remove-member-dialog'
import { RecipientPicker } from './+components/recipient-picker'
import { TeamActions } from './+components/team-actions'
import { TransferOwnerDialog } from './+components/transfer-owner-dialog'
import { Pager } from '~/components/form/pager'
import { TeamMuted } from '~/components/form/team-muted'
import { TeamUser } from './+components/team-user'
import { UpgradeNotice } from './+components/upgrade-notice'
import type { SettingsLayoutContext } from './_layout'
import { SettingsPage } from '~/components/form/settings-page'
import { SettingsSection } from '~/components/form/settings-section'
import { Badge } from '~/components/ui/badge'
import { Button } from '~/components/ui/button'
import { Field, FieldLabel } from '~/components/ui/field'
import { Input } from '~/components/ui/input'
import { IconButton } from '~/components/app/icon-button'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '~/components/ui/alert-dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '~/components/ui/dropdown-menu'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '~/components/ui/select'
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
import {
  grantWorkspaceAdmin,
  loadMembersPageData,
  parseMembersPageFilters,
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
  const data = await loadMembersPageData(createDb(), user, filters)
  return { ...data, filters }
}

export async function action({ request, context }: Route.ActionArgs) {
  const user = requireUser(context)

  const form = await request.formData()
  const intent = stringValue(form.get('intent'))
  if (!intent) return redirect('/settings?status=invalid')

  const db = createDb()
  let result: TeamMutationResult
  switch (intent) {
    case 'transfer-owner': {
      const userId = stringValue(form.get('userId'))
      if (!userId) return redirect('/settings?status=invalid')
      result = await transferWorkspaceOwner(db, user, userId)
      break
    }
    case 'grant-admin': {
      const userId = stringValue(form.get('userId'))
      if (!userId) return redirect('/settings?status=invalid')
      result = await grantWorkspaceAdmin(db, user, userId)
      break
    }
    case 'revoke-admin': {
      const userId = stringValue(form.get('userId'))
      if (!userId) return redirect('/settings?status=invalid')
      result = await revokeWorkspaceAdmin(db, user, userId)
      break
    }
    case 'revoke-cli-sessions': {
      const userId = stringValue(form.get('userId'))
      if (!userId) return redirect('/settings?status=invalid')
      result = await revokeWorkspaceMemberCliSessions(db, user, userId)
      break
    }
    case 'remove-member': {
      const userId = stringValue(form.get('userId'))
      if (!userId) return redirect('/settings?status=invalid')
      result = await removeWorkspaceMember(db, user, userId)
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
            return redirect('/settings?status=removed-transfer-failed')
          }
        }
        return redirect('/settings?status=removed')
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
        return redirect('/settings?status=invalid')
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
      if (!userId) return redirect('/settings?status=invalid')
      result = await restoreWorkspaceMember(db, user, userId)
      if (result.kind === 'not-found') {
        return redirect('/settings?status=restore-unavailable')
      }
      break
    }
    default:
      return redirect('/settings?status=invalid')
  }

  return redirect(`/settings?status=${result.kind}`)
}

export default function TeamMembersPage({ loaderData }: Route.ComponentProps) {
  const shell = useOutletContext<SettingsLayoutContext>()
  const isUpgrade = shell.kind === 'upgrade'
  const canManage = loaderData.currentUserIsAdmin

  return (
    <SettingsPage>
      <MemberSection
        members={loaderData.membersPage.members}
        total={loaderData.membersPage.total}
        page={loaderData.membersPage.page}
        filters={loaderData.filters}
        currentUser={shell.user}
        canManage={canManage}
        currentUserRole={loaderData.currentUserRole}
      />

      {canManage ? (
        <RemovedMemberSection
          members={loaderData.removedMembers}
          canManage={canManage}
          currentUser={shell.user}
        />
      ) : null}

      {isUpgrade ? (
        <UpgradeNotice titleKey="team.upgrade" isAdmin={canManage} />
      ) : null}
    </SettingsPage>
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
        <Field className="w-36">
          <FieldLabel htmlFor="member-role-filter" className="sr-only">
            {t('team.members.filter.role')}
          </FieldLabel>
          <Select name="role" defaultValue={filters.role}>
            <SelectTrigger id="member-role-filter" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">
                {t('team.members.filter.role.all')}
              </SelectItem>
              <SelectItem value="owner">
                {t('team.members.role.owner')}
              </SelectItem>
              <SelectItem value="admin">
                {t('team.members.role.admin')}
              </SelectItem>
              <SelectItem value="member">
                {t('team.members.role.member')}
              </SelectItem>
            </SelectContent>
          </Select>
        </Field>
        <Field className="w-36">
          <FieldLabel htmlFor="member-activity-filter" className="sr-only">
            {t('team.members.filter.activity')}
          </FieldLabel>
          <Select name="activity" defaultValue={filters.activity}>
            <SelectTrigger id="member-activity-filter" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">
                {t('team.members.filter.activity.all')}
              </SelectItem>
              <SelectItem value="active">
                {t('team.members.filter.activity.active')}
              </SelectItem>
              <SelectItem value="inactive">
                {t('team.members.filter.activity.inactive')}
              </SelectItem>
            </SelectContent>
          </Select>
        </Field>
        <Button type="submit" variant="outline" size="sm">
          {t('team.members.filter.apply')}
        </Button>
      </Form>

      <Table>
        <TableHeader>
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
  const navigation = useNavigation()
  const { locale, t } = useT()
  const [removeDialogOpen, setRemoveDialogOpen] = useState(false)
  const [transferOwnerDialogOpen, setTransferOwnerDialogOpen] = useState(false)
  const [revokeCliDialogOpen, setRevokeCliDialogOpen] = useState(false)
  const [selectedRecipientUserId, setSelectedRecipientUserId] = useState<
    string | null
  >(null)
  const recipientUserId = selectedRecipientUserId ?? currentUserId
  const removeFormId = `remove-member-${member.id}`
  const pendingIntent = navigation.formData
    ? stringValue(navigation.formData.get('intent'))
    : null
  const pendingUserId = navigation.formData
    ? stringValue(navigation.formData.get('userId'))
    : null
  const pendingForMember = Boolean(
    navigation.formData && pendingUserId === member.id,
  )
  const removePending = pendingForMember && pendingIntent === 'remove-member'
  const transferOwnerFormId = `transfer-owner-${member.id}`
  const transferOwnerPending =
    pendingForMember && pendingIntent === 'transfer-owner'
  const revokeCliPending =
    pendingForMember && pendingIntent === 'revoke-cli-sessions'
  const grantAdminFormId = `grant-admin-${member.id}`
  const revokeAdminFormId = `revoke-admin-${member.id}`
  const revokeCliSessionsFormId = `revoke-cli-sessions-${member.id}`
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

  return (
    <TableRow>
      <TableCell>
        <div className="flex items-center gap-[var(--spacing-2)]">
          <TeamUser name={displayName(member)} email={member.email} />
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
          {member.lastContributedAt
            ? formatRelative(member.lastContributedAt, locale)
            : '—'}
        </TeamMuted>
      </TableCell>
      <TableCell>
        <TeamActions>
          {eligibleForTransfer || eligibleForRemove || eligibleForCliRevoke ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <IconButton
                  type="button"
                  icon={IconDots}
                  size="md"
                  disabled={pendingForMember}
                  aria-label={t('team.members.menu')}
                />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {canManageRoles && member.role === 'member' ? (
                  <DropdownMenuItem
                    onSelect={() => {
                      const form = document.getElementById(grantAdminFormId)
                      if (form instanceof HTMLFormElement) form.requestSubmit()
                    }}
                  >
                    {t('team.members.makeAdmin')}
                  </DropdownMenuItem>
                ) : null}
                {canManageRoles && member.role === 'admin' ? (
                  <DropdownMenuItem
                    onSelect={() => {
                      const form = document.getElementById(revokeAdminFormId)
                      if (form instanceof HTMLFormElement) form.requestSubmit()
                    }}
                  >
                    {t('team.members.removeAdmin')}
                  </DropdownMenuItem>
                ) : null}
                {canManageRoles ? (
                  <DropdownMenuItem
                    onSelect={() => setTransferOwnerDialogOpen(true)}
                  >
                    {t('team.members.transferOwner')}
                  </DropdownMenuItem>
                ) : null}
                {eligibleForCliRevoke ? (
                  <DropdownMenuItem
                    onSelect={() => setRevokeCliDialogOpen(true)}
                  >
                    {t('team.members.revokeCliSessions')}
                  </DropdownMenuItem>
                ) : null}
                {canManageRoles && eligibleForRemove ? (
                  <DropdownMenuSeparator />
                ) : null}
                {eligibleForRemove ? (
                  <DropdownMenuItem
                    variant="destructive"
                    onSelect={() => setRemoveDialogOpen(true)}
                  >
                    {t('team.members.remove')}
                  </DropdownMenuItem>
                ) : null}
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null}
          {canManageRoles ? (
            <>
              <Form
                method="post"
                action="?index"
                id={transferOwnerFormId}
                className="hidden"
              >
                <input type="hidden" name="intent" value="transfer-owner" />
                <input type="hidden" name="userId" value={member.id} />
              </Form>
              <Form
                method="post"
                action="?index"
                id={grantAdminFormId}
                className="hidden"
              >
                <input type="hidden" name="intent" value="grant-admin" />
                <input type="hidden" name="userId" value={member.id} />
              </Form>
              <Form
                method="post"
                action="?index"
                id={revokeAdminFormId}
                className="hidden"
              >
                <input type="hidden" name="intent" value="revoke-admin" />
                <input type="hidden" name="userId" value={member.id} />
              </Form>
              <TransferOwnerDialog
                open={transferOwnerDialogOpen}
                onOpenChange={setTransferOwnerDialogOpen}
                onConfirm={() => {
                  const form = document.getElementById(transferOwnerFormId)
                  if (form instanceof HTMLFormElement) {
                    form.requestSubmit()
                  }
                }}
                memberName={displayName(member)}
                pending={transferOwnerPending}
              />
            </>
          ) : null}
          {eligibleForCliRevoke ? (
            <>
              <Form
                method="post"
                action="?index"
                id={revokeCliSessionsFormId}
                className="hidden"
              >
                <input
                  type="hidden"
                  name="intent"
                  value="revoke-cli-sessions"
                />
                <input type="hidden" name="userId" value={member.id} />
              </Form>
              <AlertDialog
                open={revokeCliDialogOpen}
                onOpenChange={setRevokeCliDialogOpen}
              >
                <AlertDialogContent size="sm">
                  <AlertDialogHeader>
                    <AlertDialogTitle>
                      {t('team.members.revokeCliSessionsConfirm.title', {
                        name: displayName(member),
                      })}
                    </AlertDialogTitle>
                    <AlertDialogDescription>
                      {t('team.members.revokeCliSessionsConfirm.body')}
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel disabled={revokeCliPending}>
                      {t('confirm.cancel')}
                    </AlertDialogCancel>
                    <AlertDialogAction
                      disabled={revokeCliPending}
                      onClick={() => {
                        const form = document.getElementById(
                          revokeCliSessionsFormId,
                        )
                        if (form instanceof HTMLFormElement)
                          form.requestSubmit()
                      }}
                    >
                      {t('team.members.revokeCliSessions')}
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            </>
          ) : null}
          <Form
            method="post"
            action="?index"
            id={removeFormId}
            className="hidden"
          >
            <input type="hidden" name="intent" value="remove-member" />
            <input type="hidden" name="userId" value={member.id} />
            <input
              type="hidden"
              name="recipientUserId"
              value={recipientUserId}
            />
          </Form>
          <RemoveMemberDialog
            open={removeDialogOpen}
            onOpenChange={(open) => {
              setRemoveDialogOpen(open)
              if (open) setSelectedRecipientUserId(null)
            }}
            onConfirm={() => {
              const form = document.getElementById(removeFormId)
              if (form instanceof HTMLFormElement) {
                form.requestSubmit()
              }
            }}
            memberName={displayName(member)}
            pending={removePending}
            currentUser={currentUser}
            excludeUserId={member.id}
            recipientUserId={recipientUserId}
            onRecipientUserIdChange={setSelectedRecipientUserId}
          />
        </TeamActions>
      </TableCell>
    </TableRow>
  )
}

function RemovedMemberSection({
  members,
  canManage,
  currentUser,
}: {
  members: RemovedTeamMember[]
  canManage: boolean
  currentUser: TeamMember
}) {
  const { t } = useT()

  if (members.length === 0) return null

  return (
    <SettingsSection
      id="removed-members"
      title={t('team.removedMembers')}
      description={t('team.removedMembers.body')}
    >
      <Table>
        <TableHeader>
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
              currentUser={currentUser}
            />
          ))}
        </TableBody>
      </Table>
    </SettingsSection>
  )
}

function RemovedMemberRow({
  member,
  canManage,
  currentUser,
}: {
  member: RemovedTeamMember
  canManage: boolean
  currentUser: TeamMember
}) {
  const currentUserId = currentUser.id
  const navigation = useNavigation()
  const { t } = useT()
  const [transferOpen, setTransferOpen] = useState(false)
  const [restoreOpen, setRestoreOpen] = useState(false)
  const [selectedRecipientUserId, setSelectedRecipientUserId] = useState<
    string | null
  >(null)
  const recipientUserId = selectedRecipientUserId ?? currentUserId
  const pendingIntent = navigation.formData
    ? stringValue(navigation.formData.get('intent'))
    : null
  const pendingUserId = navigation.formData
    ? stringValue(navigation.formData.get('userId'))
    : null
  const pendingForMember = pendingUserId === member.id
  const transferPending =
    pendingForMember && pendingIntent === 'transfer-removed-assets'
  const restorePending = pendingForMember && pendingIntent === 'restore-member'

  return (
    <TableRow>
      <TableCell>
        <TeamUser name={displayName(member)} email={member.email} />
      </TableCell>
      <TableCell>
        <TeamMuted>{member.ownedArtifactCount}</TeamMuted>
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
            onClick={() => setTransferOpen(true)}
          >
            {t('team.removedMembers.transfer')}
          </Button>
          <Button
            variant="outline"
            size="sm"
            type="button"
            disabled={!canManage || pendingForMember}
            onClick={() => setRestoreOpen(true)}
          >
            {t('team.removedMembers.restore')}
          </Button>
        </TeamActions>
        <AlertDialog
          open={transferOpen}
          onOpenChange={(open) => {
            setTransferOpen(open)
            if (open) setSelectedRecipientUserId(null)
          }}
        >
          <AlertDialogContent size="sm">
            <AlertDialogHeader>
              <AlertDialogTitle>
                {t('team.removedMembers.transferConfirm.title', {
                  name: displayName(member),
                })}
              </AlertDialogTitle>
              <AlertDialogDescription>
                {t('team.removedMembers.transferConfirm.body')}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <RecipientPicker
              excludeUserId={member.id}
              currentUser={currentUser}
              value={recipientUserId}
              onChange={setSelectedRecipientUserId}
              disabled={transferPending}
              allowNone={false}
            />
            <AlertDialogFooter>
              <AlertDialogCancel disabled={transferPending}>
                {t('confirm.cancel')}
              </AlertDialogCancel>
              <Form method="post" action="?index">
                <input
                  type="hidden"
                  name="intent"
                  value="transfer-removed-assets"
                />
                <input type="hidden" name="userId" value={member.id} />
                <input
                  type="hidden"
                  name="recipientUserId"
                  value={recipientUserId}
                />
                <AlertDialogAction type="submit" disabled={transferPending}>
                  {t('team.removedMembers.transferConfirm.action')}
                </AlertDialogAction>
              </Form>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
        <AlertDialog open={restoreOpen} onOpenChange={setRestoreOpen}>
          <AlertDialogContent size="sm">
            <AlertDialogHeader>
              <AlertDialogTitle>
                {t('team.removedMembers.restoreConfirm.title', {
                  name: displayName(member),
                })}
              </AlertDialogTitle>
              <AlertDialogDescription>
                {t('team.removedMembers.restoreConfirm.body')}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={restorePending}>
                {t('confirm.cancel')}
              </AlertDialogCancel>
              <Form method="post" action="?index">
                <input type="hidden" name="intent" value="restore-member" />
                <input type="hidden" name="userId" value={member.id} />
                <AlertDialogAction type="submit" disabled={restorePending}>
                  {t('team.removedMembers.restoreConfirm.action')}
                </AlertDialogAction>
              </Form>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </TableCell>
    </TableRow>
  )
}
