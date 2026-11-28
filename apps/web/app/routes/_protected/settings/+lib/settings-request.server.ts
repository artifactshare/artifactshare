import { createContext, type RouterContextProvider } from 'react-router'
import type {
  SettingsShellData,
  WorkspaceMemberRole,
} from '~/lib/team-management'
import { requireUser } from '~/middleware/context'
import { workspaceAdminQuery } from '~/services/access.server'
import { createDb } from '~/services/db.server'
import { planTier } from '~/lib/plan-tier'

export type SettingsWorkspaceSnapshot = {
  id: string
  name: string
  hd: string | null
  plan: string
  storage_used_bytes: number
  storage_quota_bytes: number
  stripe_subscription_id: string | null
  stripe_subscription_status: string
  link_sharing_enabled: number
  external_posting_enabled: number
  link_expiry_default_days: number | null
  link_expiry_max_days: number | null
}

type SettingsRequestReads = {
  workspace?: Promise<SettingsWorkspaceSnapshot>
  role?: Promise<WorkspaceMemberRole | null>
}

const settingsRequestReads = createContext<SettingsRequestReads | null>(null)

function readsFor(context: Readonly<RouterContextProvider>) {
  let reads = context.get(settingsRequestReads)
  if (!reads) {
    reads = {}
    context.set(settingsRequestReads, reads)
  }
  return reads
}

export function settingsWorkspace(
  context: Readonly<RouterContextProvider>,
): Promise<SettingsWorkspaceSnapshot> {
  const reads = readsFor(context)
  reads.workspace ??= readWorkspace(context)
  return reads.workspace
}

export function settingsActiveRole(
  context: Readonly<RouterContextProvider>,
): Promise<WorkspaceMemberRole | null> {
  const reads = readsFor(context)
  reads.role ??= readActiveRole(context)
  return reads.role
}

export const SETTINGS_SHELL_ROUTE_ID = 'routes/_protected/settings/_layout'

export function settingsShellLoads(request: Request) {
  const url = new URL(request.url)
  // Only a Single Fetch data request (`.data`) filters its loaders; a document
  // runs every matched loader whatever its query says.
  if (!url.pathname.endsWith('.data')) return true
  const routes = url.searchParams.get('_routes')
  return !routes || routes.split(',').includes(SETTINGS_SHELL_ROUTE_ID)
}

export async function settingsActiveAdmin(
  context: Readonly<RouterContextProvider>,
  request: Request,
) {
  if (settingsShellLoads(request) || readsFor(context).role) {
    const role = await settingsActiveRole(context)
    return role === 'owner' || role === 'admin'
  }
  const user = requireUser(context)
  const row = await workspaceAdminQuery(
    createDb(),
    user.id,
    user.workspaceId,
  ).executeTakeFirst()
  return Boolean(row)
}

export async function loadSettingsShell(
  context: Readonly<RouterContextProvider>,
): Promise<SettingsShellData> {
  const [workspace, role] = await Promise.all([
    settingsWorkspace(context),
    settingsActiveRole(context),
  ])
  const currentUserRole = role ?? 'member'
  return {
    kind: planTier(workspace.plan) === 'team' ? 'team' : 'upgrade',
    workspace: {
      id: workspace.id,
      name: workspace.name,
      hd: workspace.hd,
      plan: workspace.plan,
      storageUsedBytes: workspace.storage_used_bytes,
      storageQuotaBytes: workspace.storage_quota_bytes,
    },
    currentUserIsAdmin: currentUserRole !== 'member',
    currentUserRole,
  }
}

function readWorkspace(context: Readonly<RouterContextProvider>) {
  const user = requireUser(context)
  return createDb()
    .selectFrom('workspaces')
    .select([
      'id',
      'name',
      'hd',
      'plan',
      'storage_used_bytes',
      'storage_quota_bytes',
      'stripe_subscription_id',
      'stripe_subscription_status',
      'link_sharing_enabled',
      'external_posting_enabled',
      'link_expiry_default_days',
      'link_expiry_max_days',
    ])
    .where('id', '=', user.workspaceId)
    .executeTakeFirstOrThrow()
}

async function readActiveRole(context: Readonly<RouterContextProvider>) {
  const user = requireUser(context)
  const row = await createDb()
    .selectFrom('workspace_members')
    .select('role')
    .where('workspace_id', '=', user.workspaceId)
    .where('user_id', '=', user.id)
    .where('status', '=', 'active')
    .executeTakeFirst()
  return (row?.role ?? null) as WorkspaceMemberRole | null
}
