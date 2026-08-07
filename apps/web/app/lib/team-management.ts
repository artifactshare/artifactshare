import type { ProjectBaseVisibility, Visibility } from './shareable-types'

export const WORKSPACE_NAME_MAX_LENGTH = 100

export type WorkspaceMemberRole = 'owner' | 'admin' | 'member'

export interface SettingsShellData {
  kind: 'upgrade' | 'team'
  workspace: TeamWorkspace
  currentUserIsAdmin: boolean
  currentUserRole: WorkspaceMemberRole
}

export const MEMBERS_PAGE_SIZE = 50
export const AUDIT_EVENTS_PAGE_SIZE = 50
export const INVENTORY_PAGE_SIZE = 50

export interface InventoryArtifactsFilters {
  visibility: 'all' | Visibility
  sort: 'updated' | 'size'
  page: number
}

export interface InventoryProjectEntry {
  id: string
  name: string
  archivedAt: string | null
  baseVisibility: ProjectBaseVisibility
  artifactCount: number
  sizeBytes: number | null
  updatedAt: string
}

export interface InventoryArtifactEntry {
  id: string
  name: string
  owner: { name: string | null; email: string }
  location: { kind: 'project' | 'inbox'; name: string }
  visibility: Visibility
  sizeBytes: number | null
  updatedAt: string
}

export interface AuditEventEntry {
  id: string
  action: string
  createdAt: string
  actor: TeamMember | null
  subject: TeamMember | null
  detail: {
    name?: string | null
    email?: string | null
    from?: string | null
    to?: string | null
    fromRole?: string | null
    toRole?: string | null
    recipientEmail?: string | null
    artifactCount?: number | null
  }
}

export interface AuditEventsPageResult {
  events: AuditEventEntry[]
  total: number
  page: number
}

export type MemberRoleFilter = 'all' | 'owner' | 'admin' | 'member'
export type MemberActivityFilter = 'all' | 'active' | 'inactive'

export interface MembersPageFilters {
  query: string
  role: MemberRoleFilter
  activity: MemberActivityFilter
  page: number
}

export interface MembersPageResult {
  members: TeamContributor[]
  total: number
  page: number
}

export interface RecipientSearchData {
  query: string
  recipients: TeamMember[]
  total: number
  failed?: boolean
}

export interface TeamWorkspace {
  id: string
  name: string
  hd: string | null
  plan: string
  storageUsedBytes: number
  storageQuotaBytes: number
}

export interface TeamMember {
  id: string
  email: string
  name: string | null
  image: string | null
}

export interface TeamContributor extends TeamMember {
  firstContributedAt: string | null
  lastContributedAt: string | null
  pendingUploads: number
  isAdmin: boolean
  role: WorkspaceMemberRole
}

export interface RemovedTeamMember extends TeamMember {
  ownedArtifactCount: number
}

export type TeamMutationResult =
  | { kind: 'ok' }
  | { kind: 'forbidden' }
  | { kind: 'not-team' }
  | { kind: 'not-found' }
  | { kind: 'self-forbidden' }
  | { kind: 'invalid' }
  | { kind: 'external-failed' }

export function displayName(user: {
  name: string | null
  email: string
}): string {
  return user.name?.trim() || user.email
}
