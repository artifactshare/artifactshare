import { renderToStaticMarkup } from 'react-dom/server'
import type { AnchorHTMLAttributes, ReactNode } from 'react'
import { describe, expect, test, vi } from 'vitest'

const services = vi.hoisted(() => ({
  grantWorkspaceAdmin: vi.fn(),
  revokeWorkspaceAdmin: vi.fn(),
  revokeWorkspaceMemberCliSessions: vi.fn(),
  transferWorkspaceOwner: vi.fn(),
  removeWorkspaceMember: vi.fn(),
  restoreWorkspaceMember: vi.fn(),
  transferRemovedMemberAssets: vi.fn(),
  updateWorkspaceName: vi.fn(),
}))

vi.mock('~/services/db.server', () => ({ createDb: () => ({}) }))
vi.mock('~/middleware/context', () => ({
  requireUser: () => ({ id: 'owner', workspaceId: 'workspace' }),
}))
vi.mock('~/services/team-management.server', () => services)

const pageState = vi.hoisted(() => ({
  context: null as unknown,
  locale: 'en' as 'en' | 'ja',
  navigation: { formData: undefined as FormData | undefined },
}))

vi.mock('react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router')>()
  return {
    ...actual,
    Form: ({ children, ...props }: { children: ReactNode }) => (
      <form {...props}>{children}</form>
    ),
    Link: ({
      children,
      to,
      ...props
    }: AnchorHTMLAttributes<HTMLAnchorElement> & { to: string }) => (
      <a href={to} {...props}>
        {children}
      </a>
    ),
    useNavigation: () => pageState.navigation,
    useOutletContext: () => pageState.context,
    useFetcher: () => ({
      state: 'idle',
      data: undefined,
      load: () => {},
    }),
  }
})

vi.mock('~/hooks/use-t', () => ({
  useT: () => ({
    locale: pageState.locale,
    t: (key: string, vars?: Record<string, string | number>) => {
      const labels: Record<string, Record<string, string>> = {
        en: {
          'team.workspace.name': 'Display name',
          'team.workspace.name.body':
            'Change the display name for this workspace.',
          'team.workspace.name.label': 'Display name',
          'team.workspace.name.save': 'Save',
          'team.members': 'Members',
          'team.members.body': 'Manage members in this workspace.',
          'team.members.user': 'User',
          'team.members.lastUpload': 'Last upload',
          'team.members.actions': 'Actions',
          'team.members.owner': 'Workspace owner',
          'team.members.role.owner': 'Owner',
          'team.members.role.admin': 'Admin',
          'team.members.makeAdmin': 'Make admin',
          'team.members.removeAdmin': 'Remove admin',
          'team.members.transferOwner': 'Transfer ownership',
          'team.members.menu': 'Member actions menu',
          'team.members.remove': 'Remove',
          'team.members.revokeCliSessions': 'Revoke CLI sessions',
          'team.members.revokeCliSessionsConfirm.title': `Revoke CLI sessions for ${vars?.name ?? ''}?`,
          'team.members.revokeCliSessionsConfirm.body': 'Sign in again.',
          'team.members.empty': 'No members yet.',
          'team.guides.title': 'Role guides',
          'team.guides.body': 'Read the guide for your workspace role.',
          'team.guides.admin': 'Admin guide',
          'team.guides.admin.primary':
            'Admin guide — day-to-day member management',
          'team.guides.owner': 'Owner guide',
          'team.guides.owner.reference': 'Owner guide — owner-only procedures',
          'team.members.transferOwnerConfirm.title': `Transfer ownership to ${vars?.name ?? ''}?`,
          'team.members.transferOwnerConfirm.body':
            'You will become an admin after this transfer. You will no longer be the owner.',
          'team.members.transferOwnerConfirm.action': 'Transfer ownership',
          'confirm.cancel': 'Cancel',
          'team.removedMembers': 'Removed members',
          'team.removedMembers.body': 'Restore removed members.',
          'team.removedMembers.artifacts': 'Artifacts',
          'team.upgrade': 'Upgrade',
        },
        ja: {
          'team.workspace.name': '表示名',
          'team.workspace.name.body': 'ワークスペースの表示名を変更します。',
          'team.workspace.name.label': '表示名',
          'team.workspace.name.save': '保存',
          'team.members': 'メンバー',
          'team.members.body': 'このワークスペースのメンバーを管理します。',
          'team.members.user': 'ユーザー',
          'team.members.lastUpload': '最終アップロード',
          'team.members.actions': '操作',
          'team.members.owner': 'ワークスペースのオーナー',
          'team.members.role.owner': 'オーナー',
          'team.members.role.admin': '管理者',
          'team.members.makeAdmin': '管理者にする',
          'team.members.removeAdmin': '管理者を解除',
          'team.members.transferOwner': 'オーナーを移譲',
          'team.members.menu': 'メンバー操作メニュー',
          'team.members.remove': '削除',
          'team.members.revokeCliSessions': 'CLIセッションを失効',
          'team.members.revokeCliSessionsConfirm.title': `${vars?.name ?? ''} のCLIセッションを失効しますか？`,
          'team.members.revokeCliSessionsConfirm.body':
            '再ログインが必要です。',
          'team.members.empty': 'メンバーはまだいません。',
          'team.guides.title': '役割別ガイド',
          'team.guides.body':
            'ワークスペースの役割に合ったガイドを確認できます。',
          'team.guides.admin': '管理者ガイド',
          'team.guides.admin.primary': '管理者ガイド — 日常のメンバー管理',
          'team.guides.owner': 'オーナーガイド',
          'team.guides.owner.reference':
            'オーナーガイド — オーナーだけの手続き',
          'team.members.transferOwnerConfirm.title': `${vars?.name ?? ''} にオーナーを移譲しますか？`,
          'team.members.transferOwnerConfirm.body':
            '移譲後、あなた自身は管理者になります。オーナーではなくなります。',
          'team.members.transferOwnerConfirm.action': 'オーナーを移譲',
          'confirm.cancel': 'キャンセル',
          'team.removedMembers': '削除済みメンバー',
          'team.removedMembers.body': '削除済みメンバーを復元します。',
          'team.removedMembers.artifacts': '成果物',
          'team.upgrade': 'アップグレード',
        },
      }
      return labels[pageState.locale][key] ?? key
    },
  }),
}))

vi.mock('~/components/ui/dropdown-menu', () => ({
  DropdownMenu: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  DropdownMenuTrigger: ({ children }: { children: ReactNode }) => (
    <>{children}</>
  ),
  DropdownMenuContent: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  DropdownMenuItem: ({ children }: { children: ReactNode }) => (
    <button type="button">{children}</button>
  ),
  DropdownMenuSeparator: () => <hr />,
}))

vi.mock('~/components/ui/alert-dialog', () => ({
  AlertDialog: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  AlertDialogContent: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  AlertDialogHeader: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  AlertDialogFooter: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  AlertDialogTitle: ({ children }: { children: ReactNode }) => (
    <h2>{children}</h2>
  ),
  AlertDialogDescription: ({ children }: { children: ReactNode }) => (
    <p>{children}</p>
  ),
  AlertDialogAction: ({ children, ...props }: { children: ReactNode }) => (
    <button {...props}>{children}</button>
  ),
  AlertDialogCancel: ({ children, ...props }: { children: ReactNode }) => (
    <button {...props}>{children}</button>
  ),
}))

vi.mock('~/components/ui/select', () => ({
  Select: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SelectContent: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  SelectItem: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SelectTrigger: ({ children }: { children: ReactNode }) => (
    <button type="button">{children}</button>
  ),
  SelectValue: () => null,
}))

vi.mock('~/components/form/settings-page', () => ({
  SettingsPage: ({ children }: { children: ReactNode }) => (
    <main>{children}</main>
  ),
}))
vi.mock('~/components/form/settings-section', () => ({
  SettingsSection: ({
    title,
    description,
    actions,
    children,
  }: {
    title: string
    description: string
    actions?: ReactNode
    children: ReactNode
  }) => (
    <section>
      <h2>{title}</h2>
      <p>{description}</p>
      {actions}
      {children}
    </section>
  ),
}))
vi.mock('./+components/team-user', () => ({
  TeamUser: ({ name, email }: { name: string; email: string }) => (
    <span>
      {name} {email}
    </span>
  ),
}))
vi.mock('~/components/form/team-muted', () => ({
  TeamMuted: ({ children }: { children: ReactNode }) => <span>{children}</span>,
}))
vi.mock('./+components/upgrade-notice', () => ({ UpgradeNotice: () => null }))

import { action } from './index'
import TeamMembersPage from './index'
import { TransferOwnerDialog } from './+components/transfer-owner-dialog'

function postForm(fields: Record<string, string>) {
  const form = new URLSearchParams(fields)
  return new Request('https://artifactshare.com/settings', {
    method: 'POST',
    body: form,
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
  })
}

function member(
  id: string,
  role: 'owner' | 'admin' | 'member',
): Record<string, unknown> {
  return {
    id,
    role,
    email: `${id}@example.com`,
    name: id,
    image: null,
    firstContributedAt: null,
    lastContributedAt: null,
    pendingUploads: 0,
    isAdmin: role === 'owner' || role === 'admin',
  }
}

function renderPage({
  currentUserRole,
  members,
  navigation,
  locale = 'en',
}: {
  currentUserRole: 'owner' | 'admin' | 'member'
  members: Record<string, unknown>[]
  navigation?: { formData: FormData | undefined }
  locale?: 'en' | 'ja'
}) {
  pageState.locale = locale
  pageState.navigation = navigation ?? { formData: undefined }
  pageState.context = {
    kind: 'team',
    workspace: { id: 'workspace', name: 'Example', plan: 'team' },
    user: {
      id: currentUserRole === 'owner' ? 'owner' : currentUserRole,
      email: `${currentUserRole}@example.com`,
      name: currentUserRole,
      image: null,
    },
    currentUserIsAdmin: currentUserRole !== 'member',
    currentUserRole,
  }
  const loaderData = {
    admin: {
      id: 'owner',
      email: 'owner@example.com',
      name: 'owner',
      image: null,
    },
    membersPage: { members, total: members.length },
    removedMembers: [],
    currentUserRole,
    currentUserIsAdmin: currentUserRole !== 'member',
    filters: { query: '', role: 'all', activity: 'all', page: 1 },
  }
  return renderToStaticMarkup(
    <TeamMembersPage
      {...({ loaderData } as unknown as Parameters<typeof TeamMembersPage>[0])}
    />,
  )
}

describe('/settings role actions', () => {
  test.each([
    ['grant-admin', 'grantWorkspaceAdmin'],
    ['revoke-admin', 'revokeWorkspaceAdmin'],
    ['transfer-owner', 'transferWorkspaceOwner'],
    ['revoke-cli-sessions', 'revokeWorkspaceMemberCliSessions'],
  ])('%s dispatches to the phase-1 service', async (intent, service) => {
    services[service as keyof typeof services].mockResolvedValue({ kind: 'ok' })

    const response = await action({
      request: postForm({ intent, userId: 'target' }),
      context: new Map(),
    } as never)

    expect(response.headers.get('Location')).toBe('/settings?status=ok')
    expect(services[service as keyof typeof services]).toHaveBeenCalledWith(
      {},
      { id: 'owner', workspaceId: 'workspace' },
      'target',
    )
  })
})

describe('/settings rendered member management', () => {
  test.each([
    ['en', 'Owner', 'Admin'],
    ['ja', 'オーナー', '管理者'],
  ] as const)('renders %s role badges', (locale, ownerLabel, adminLabel) => {
    const html = renderPage({
      locale,
      currentUserRole: 'member',
      members: [
        member('owner', 'owner'),
        member('admin', 'admin'),
        member('member', 'member'),
      ],
    })

    expect(html).toContain(ownerLabel)
    expect(html).toContain(adminLabel)
  })

  test('owner gets role controls for members and admins, but not self', () => {
    const html = renderPage({
      currentUserRole: 'owner',
      members: [
        member('owner', 'owner'),
        member('member', 'member'),
        member('admin', 'admin'),
      ],
    })

    expect(html.match(/Make admin/g)).toHaveLength(1)
    expect(html.match(/Remove admin/g)).toHaveLength(1)
    expect(html.match(/name="intent" value="transfer-owner"/g)).toHaveLength(2)
    expect(html.match(/aria-label="Member actions menu"/g)).toHaveLength(2)
    expect(html).toContain('Owner')
  })

  test('admin can remove an ordinary member but has no role mutation controls', () => {
    const html = renderPage({
      currentUserRole: 'admin',
      members: [member('admin', 'admin'), member('member', 'member')],
    })

    expect(html).toContain('Remove')
    expect(html).not.toContain('Make admin')
    expect(html).not.toContain('Remove admin')
    expect(html).not.toContain('Transfer ownership')
    expect(html).not.toContain('name="intent" value="grant-admin"')
    expect(html).not.toContain('name="intent" value="revoke-admin"')
    expect(html).not.toContain('name="intent" value="transfer-owner"')
    expect(html).toContain('Revoke CLI sessions')
  })

  test('CLI revoke is absent for admins and owners', () => {
    const html = renderPage({
      currentUserRole: 'owner',
      members: [member('owner', 'owner'), member('admin', 'admin')],
    })

    expect(html).not.toContain('Revoke CLI sessions')
    expect(html).not.toContain('name="intent" value="revoke-cli-sessions"')
  })

  test('member has no management menu or role guide section', () => {
    const html = renderPage({
      currentUserRole: 'member',
      members: [member('member', 'member'), member('other', 'member')],
    })

    expect(html).not.toContain('Member actions menu')
    expect(html).not.toContain('Role guides')
  })

  test('only the submitted member row disables its menu trigger', () => {
    const formData = new FormData()
    formData.set('intent', 'remove-member')
    formData.set('userId', 'member')
    const html = renderPage({
      currentUserRole: 'admin',
      members: [member('member', 'member'), member('other', 'member')],
      navigation: { formData },
    })

    expect(html).toMatch(/disabled=""[^>]*aria-label="Member actions menu"/)
    expect(html).toMatch(/aria-label="Member actions menu"(?![^>]*disabled)/)
  })
})

describe('TransferOwnerDialog', () => {
  test.each([
    ['en', 'You will become an admin after this transfer.'],
    ['ja', '移譲後、あなた自身は管理者になります。'],
  ] as const)('renders the %s ownership consequence', (locale, copy) => {
    pageState.locale = locale
    const html = renderToStaticMarkup(
      <TransferOwnerDialog
        open
        onOpenChange={vi.fn()}
        onConfirm={vi.fn()}
        memberName="Target"
        pending={false}
      />,
    )

    expect(html).toContain(copy)
  })
})
