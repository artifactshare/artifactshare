import {
  RouterContextProvider,
  RouterProvider,
  createMemoryRouter,
  Outlet,
  useFetcher,
} from 'react-router'
import { renderToStaticMarkup } from 'react-dom/server'
import type { ReactNode } from 'react'
import { describe, expect, test, vi } from 'vitest'

vi.mock('cloudflare:workers', () => ({ env: {} }))

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
}))

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
          'team.members.revokeCliSessionsConfirm.title': `${vars?.name ?? ''} のCLIセッションを失効させますか？`,
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
vi.mock('../+components/team-user', () => ({
  TeamUser: ({ name, email }: { name: string; email: string }) => (
    <span>
      {name} {email}
    </span>
  ),
}))

vi.mock('../+components/upgrade-notice', () => ({ UpgradeNotice: () => null }))

import { action } from './index'
import TeamMembersPage from './index'
import BotsPage from './bots'
import { MemberConfirmation } from '../+components/member-confirmation'
import type { TeamContributor } from '~/lib/team-management'
import type { WorkspaceBotRow } from '~/services/bot-members.server'

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
): TeamContributor {
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
  locale = 'en',
}: {
  currentUserRole: 'owner' | 'admin' | 'member'
  members: TeamContributor[]
  locale?: 'en' | 'ja'
}) {
  pageState.locale = locale
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
    membersPage: { members, total: members.length, page: 1 },
    removedMembers: [],
    filters: { query: '', role: 'all', activity: 'all', page: 1 },
  } satisfies Parameters<typeof TeamMembersPage>[0]['loaderData']
  return renderToStaticMarkup(
    <RouterProvider
      router={createMemoryRouter([
        {
          element: <Outlet context={pageState.context} />,
          children: [
            {
              path: '/',
              element: <TeamMembersPage loaderData={loaderData} />,
            },
          ],
        },
      ])}
    />,
  )
}

describe('/settings role actions', () => {
  test.each([
    ['ok', 'removed'],
    ['invalid', 'removed-transfer-failed'],
  ])(
    'reports the committed removal after a transfer returning %s',
    async (kind, status) => {
      services.removeWorkspaceMember.mockResolvedValueOnce({ kind: 'ok' })
      services.transferRemovedMemberAssets.mockResolvedValueOnce({ kind })
      const request = postForm({
        intent: 'remove-member',
        userId: 'target',
        recipientUserId: 'owner',
      })
      const response = await action({
        request,
        context: new RouterContextProvider(),
        params: {},
        url: new URL(request.url),
        pattern: '/settings',
      })
      expect(response.data).toEqual({
        code: status,
        ok: kind === 'ok',
        intent: 'remove-member',
        ...(kind !== 'ok' && { removalCommitted: true }),
      })
      expect(response.init?.status).toBe(kind === 'ok' ? 200 : 409)
    },
  )
  test('returns an invalid result for missing owner input', async () => {
    const request = postForm({ intent: 'grant-admin' })
    const response = await action({
      request,
      context: new RouterContextProvider(),
      params: {},
      url: new URL(request.url),
      pattern: '/settings',
    })
    expect(response).toMatchObject({
      data: { ok: false, code: 'invalid', intent: 'grant-admin' },
      init: { status: 400 },
    })
  })
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

    expect(response).toMatchObject({
      data: { ok: true, code: 'ok', intent },
      init: { status: 200 },
    })
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

  test('an admin in an ownerless workspace keeps the Admin badge', () => {
    const html = renderPage({
      currentUserRole: 'admin',
      members: [member('admin', 'admin')],
    })
    expect(html).toContain('>Admin<')
    expect(html).not.toContain('>Owner<')
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
    expect(html.match(/>Transfer ownership</g)).toHaveLength(2)
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
})

describe('ownership transfer confirmation', () => {
  test.each([
    ['en', 'You will become an admin after this transfer.'],
    ['ja', '移譲後、あなた自身は管理者になります。'],
  ] as const)('renders the %s ownership consequence', (locale, copy) => {
    pageState.locale = locale
    const html = renderToStaticMarkup(
      <RouterProvider
        router={createMemoryRouter([
          {
            path: '/',
            Component: function Confirmation() {
              const fetcher = useFetcher<typeof action>()
              return (
                <MemberConfirmation
                  target={{
                    intent: 'transfer-owner',
                    member: member('target', 'member'),
                    triggerId: 'transfer',
                  }}
                  currentUser={member('owner', 'owner')}
                  close={() => {}}
                  fetcher={fetcher}
                />
              )
            },
          },
        ])}
      />,
    )

    expect(html).toContain(copy)
  })
})

describe('/settings/bots page', () => {
  function renderWithBots(bots: WorkspaceBotRow[]) {
    pageState.context = {
      kind: 'team',
      workspace: { id: 'workspace', name: 'Example', plan: 'team' },
      user: {
        id: 'owner',
        email: 'owner@example.com',
        name: 'owner',
        image: null,
      },
      currentUserIsAdmin: true,
      currentUserRole: 'owner',
    }
    const loaderData = {
      bots,
      botCreationEnabled: true,
    }
    return renderToStaticMarkup(
      <RouterProvider
        router={createMemoryRouter([
          {
            path: '/',
            element: <BotsPage loaderData={loaderData} />,
          },
        ])}
      />,
    )
  }

  const activeBot = {
    id: 'bot1',
    cancelable: false,
    name: 'Deploy bot',
    email: 'bot-abc@bots.artifactshare.invalid',
    botStoppedAt: null,
    projectId: 'proj1',
    projectName: 'Project 1',
    projectNameSnapshot: 'Project 1',
    credentialLive: true,
    lastAuthAt: '2026-07-01T00:00:00.000Z',
  }

  test('shows approved destinations and primary with editing available when creation is off', () => {
    const html = renderWithBots([
      {
        ...activeBot,
        approvedProjects: [
          { id: 'proj1', name: 'Reports', unavailable: false },
          { id: 'prj2', name: 'Management', unavailable: true },
        ],
      },
    ])
    expect(html).toContain('Reports')
    expect(html).toContain('Management')
    expect(html).toContain('team.bots.primary')
    expect(html).toContain('team.bots.unavailable')
    expect(html).toContain('team.bots.editDestinations')
  })

  test('active bots render badge, status, email, destination, and actions', () => {
    const html = renderWithBots([activeBot])
    expect(html).toContain('bot-badge')
    expect(html).toContain('team.bots.status.active')
    expect(html).toContain('bot-abc@bots.artifactshare.invalid')
    expect(html).toContain('Project 1')
    expect(html).toContain('team.bots.stop')
    expect(html).toContain('team.bots.reissue')
  })

  test('expired badge takes priority over active; stopped hides actions', () => {
    const expired = { ...activeBot, credentialLive: false }
    const expiredHtml = renderWithBots([expired])
    expect(expiredHtml).toContain('team.bots.status.expired')
    expect(expiredHtml).not.toContain('team.bots.status.active')

    const stopped = {
      ...activeBot,
      botStoppedAt: '2026-08-01T00:00:00.000Z',
      credentialLive: false,
    }
    const stoppedHtml = renderWithBots([stopped])
    expect(stoppedHtml).toContain('team.bots.status.stopped')
    expect(stoppedHtml).not.toContain('>team.bots.reissue<')
    // Stopped rows expose no stop/reissue buttons.
    expect(stoppedHtml).not.toContain('>team.bots.stop<')
  })

  test('deleted destination falls back to the snapshot label', () => {
    const orphaned = {
      ...activeBot,
      projectId: null,
      projectName: null,
      projectNameSnapshot: 'Old project',
    }
    const html = renderWithBots([orphaned])
    expect(html).toContain('team.bots.destinationDeleted')
  })
})
