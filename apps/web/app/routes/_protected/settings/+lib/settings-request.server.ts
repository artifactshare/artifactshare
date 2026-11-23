import type { RouterContextProvider } from 'react-router'
import type {
  SettingsShellData,
  WorkspaceMemberRole,
} from '~/lib/team-management'
import { requireUser } from '~/middleware/context'
import { workspaceAdminQuery } from '~/services/access.server'
import { createDb } from '~/services/db.server'

/**
 * The workspace row Settings reads once per request. It stays on the server:
 * the shell serializes only its display projection, and billing and external
 * access derive their own feature responses from it.
 */
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

// Keyed by the request's router context, so a read never outlives its request.
const requests = new WeakMap<object, SettingsRequestReads>()

function readsFor(context: Readonly<RouterContextProvider>) {
  let reads = requests.get(context)
  if (!reads) {
    reads = {}
    requests.set(context, reads)
  }
  return reads
}

/**
 * The viewer's workspace, read at most once per request whichever of the
 * Settings middleware and loaders asks first.
 */
export function settingsWorkspace(
  context: Readonly<RouterContextProvider>,
): Promise<SettingsWorkspaceSnapshot> {
  const reads = readsFor(context)
  reads.workspace ??= readWorkspace(context)
  return reads.workspace
}

/**
 * The viewer's role from their active membership in the current workspace, or
 * null without one. Read at most once per request.
 */
export function settingsActiveRole(
  context: Readonly<RouterContextProvider>,
): Promise<WorkspaceMemberRole | null> {
  const reads = readsFor(context)
  reads.role ??= readActiveRole(context)
  return reads.role
}

export const SETTINGS_SHELL_ROUTE_ID = 'routes/_protected/settings/_layout'

/**
 * Whether this request runs the Settings shell loader. A document always
 * does; a Single Fetch data request does only when it names the shell among
 * the routes it loads. Pages use the shell's reads when it runs and their own
 * feature readers when only they revalidate.
 */
export function settingsShellLoads(request: Request) {
  const url = new URL(request.url)
  // Only a Single Fetch data request (`.data`) filters its loaders; a document
  // runs every matched loader whatever its query says.
  if (!url.pathname.endsWith('.data')) return true
  const routes = url.searchParams.get('_routes')
  return !routes || routes.split(',').includes(SETTINGS_SHELL_ROUTE_ID)
}

/**
 * Whether the viewer is an active admin. The shell's role read answers it
 * when the shell runs in this request; a page revalidating alone checks with
 * the shared admin query.
 */
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

/** The serialized Settings shell: display fields only, for every viewer. */
export async function loadSettingsShell(
  context: Readonly<RouterContextProvider>,
): Promise<SettingsShellData> {
  const [workspace, role] = await Promise.all([
    settingsWorkspace(context),
    settingsActiveRole(context),
  ])
  const currentUserRole = role ?? 'member'
  return {
    kind: workspace.plan === 'team' ? 'team' : 'upgrade',
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
