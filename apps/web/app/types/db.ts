// Hand-maintained DB types. Mirrors db/schema.sql.
// SQLite stores: TEXT for ISO 8601 datetimes, INTEGER 0/1 for booleans.

import type { Generated } from 'kysely'
import type {
  ArtifactKind,
  ProjectShareRole,
  Visibility,
  VersionStatus,
} from '~/lib/shareable-types'

export interface DB {
  workspaces: WorkspacesTable
  workspace_domain_claims: WorkspaceDomainClaimsTable
  workspace_members: WorkspaceMembersTable
  audit_events: AuditEventsTable
  events: EventsTable
  project_pins: ProjectPinsTable
  billing_webhook_events: BillingWebhookEventsTable
  workspace_storage_daily_usage: WorkspaceStorageDailyUsageTable
  billing_overage_charges: BillingOverageChargesTable
  artifact_containers: ArtifactContainersTable
  project_share_defaults: ProjectShareDefaultsTable
  project_members: ProjectMembersTable
  users: UsersTable
  accounts: AccountsTable
  sessions: SessionsTable
  cli_refresh_credentials: CliRefreshCredentialsTable
  cli_refresh_sessions: CliRefreshSessionsTable
  deviceCode: DeviceCodeTable
  verifications: VerificationsTable
  shareables: ShareablesTable
  shareable_grants: ShareableGrantsTable
  versions: VersionsTable
  version_files: VersionFilesTable
  comment_threads: CommentThreadsTable
  comment_messages: CommentMessagesTable
  comment_anchors: CommentAnchorsTable
  shareable_viewer_recency: ShareableViewerRecencyTable
  sandbox_token_uses: SandboxTokenUsesTable
  slack_workspaces: SlackWorkspacesTable
  slack_user_links: SlackUserLinksTable
  container_slack_channels: ContainerSlackChannelsTable
  slack_notification_outbox: SlackNotificationOutboxTable
  slack_notify_nonces: SlackNotifyNoncesTable
  mcp_artifact_posts: McpArtifactPostsTable
  pending_signup_analytics: PendingSignupAnalyticsTable
  first_post_analytics: FirstPostAnalyticsTable
  artifact_keys: ArtifactKeysTable
  api_tokens: ApiTokensTable
}

interface FirstPostAnalyticsTable {
  user_id: string
  channel: 'web' | 'cli' | 'mcp' | null
  first_posted_at: string
}

interface EventsTable {
  id: string
  workspace_id: string
  type:
    | 'artifact_created'
    | 'version_published'
    | 'comment_posted'
    | 'artifact_viewed'
  shareable_id: string
  actor_user_id: string | null
  subject_id: string | null
  created_at: string
}

interface ProjectPinsTable {
  container_id: string
  shareable_id: string
  pinned_by_user_id: string | null
  created_at: string
}

interface WorkspacesTable {
  id: string
  hd: string | null // Google Workspace hosted-domain (NULL for personal Gmail)
  ms_tenant_id: string | null
  email_domain: string | null
  name: string
  created_at: string
  plan: Generated<string>
  storage_quota_bytes: Generated<number>
  self_upload_enabled: Generated<number>
  storage_used_bytes: Generated<number>
  storage_updated_at: Generated<string>
  stripe_customer_id: string | null
  stripe_subscription_id: string | null
  stripe_subscription_status: Generated<string>
  link_sharing_enabled: Generated<number>
  external_posting_enabled: Generated<number>
  link_expiry_default_days: Generated<number | null>
  link_expiry_max_days: Generated<number | null>
}

interface WorkspaceDomainClaimsTable {
  domain: string
  workspace_id: string
  source: 'google_hd' | 'microsoft_verified_domain'
  provider_tenant_id: string | null
  created_at: string
  updated_at: string
}

interface WorkspaceMembersTable {
  workspace_id: string
  user_id: string
  role: 'owner' | 'admin' | 'member'
  status: 'active' | 'removed'
  first_contributed_at: string | null
  last_contributed_at: string | null
  pending_uploads: Generated<number>
  removed_at: string | null
  removed_by: string | null
  created_at: string
  updated_at: string
}

interface AuditEventsTable {
  id: string
  workspace_id: string
  actor_user_id: string | null
  action: string
  subject_type: string
  subject_id: string
  detail: string | null
  created_at: string
}

interface BillingWebhookEventsTable {
  stripe_event_id: string
  event_type: string
  received_at: string
  processed_at: string | null
  error: string | null
}

interface WorkspaceStorageDailyUsageTable {
  workspace_id: string
  date: string
  used_bytes: number
  included_bytes: number
  billable_overage_gb: number
}

interface BillingOverageChargesTable {
  workspace_id: string
  month: string
  overage_gb_month: number
  status: 'pending' | 'completed' | 'failed'
  stripe_invoice_item_id: string | null
  stripe_invoice_id: string | null
  created_at: string
  processed_at: string | null
}

interface ArtifactContainersTable {
  id: string
  workspace_id: string
  kind: 'inbox' | 'project'
  owner_user_id: string | null
  created_by_id: string | null
  name: string
  description: string | null
  // プロジェクトの公開範囲のベース。'workspace'=社内全員、'private'=関係者のみ。
  // inbox では使わない。
  base_visibility: Generated<'workspace' | 'private'>
  archived_at: string | null
  created_at: string
  updated_at: string
}

interface ProjectShareDefaultsTable {
  id: string
  project_container_id: string
  email: string
  role: Generated<ProjectShareRole>
  display_name: string | null
  created_by_id: string | null
  created_at: string
  updated_at: string
}

interface ProjectMembersTable {
  container_id: string
  user_id: string
  joined_at: string
  last_seen_at: string
}

interface UsersTable {
  id: string
  email: string
  email_verified: number
  name: string | null
  image: string | null
  created_at: string
  updated_at: string
  workspace_id: string
  locale: string | null
}

interface AccountsTable {
  id: string
  user_id: string
  provider_id: string
  account_id: string
  access_token: string | null
  access_token_expires_at: string | null
  refresh_token: string | null
  refresh_token_expires_at: string | null
  id_token: string | null
  scope: string | null
  password: string | null
  created_at: string
  updated_at: string
}

interface SessionsTable {
  id: string
  user_id: string
  token: string
  expires_at: string
  ip_address: string | null
  user_agent: string | null
  created_at: string
  updated_at: string
}

interface CliRefreshCredentialsTable {
  id: string
  user_id: string
  token_hash: string
  expires_at: string
  revoked_at: string | null
  created_at: string
  last_used_at: string | null
  family_id: string | null
  replaced_by_id: string | null
  rotation_request_hash: string | null
  rotation_retry_until: string | null
  rotation_session_id: string | null
  device_name: string | null
}

interface CliRefreshSessionsTable {
  session_id: string
  credential_id: string
  family_id: string
}

interface DeviceCodeTable {
  id: string
  deviceCode: string
  userCode: string
  userId: string | null
  expiresAt: string
  status: 'pending' | 'approved' | 'denied'
  lastPolledAt: string | null
  pollingInterval: number | null
  clientId: string | null
  scope: string | null
}

interface VerificationsTable {
  id: string
  identifier: string
  value: string
  expires_at: string
  created_at: string
  updated_at: string
}

interface ShareablesTable {
  id: string
  workspace_id: string
  owner_user_id: string
  slug: string | null
  name: string
  derived_title: string | null
  title_override: string | null
  description: string | null
  artifact_kind: ArtifactKind
  visibility: Visibility
  current_version_id: string | null
  view_count: Generated<number>
  container_id: string | null
  created_at: string
  updated_at: string
  last_accessed_at: string | null
  link_expires_at: string | null
}

interface ShareableGrantsTable {
  shareable_id: string
  granted_email: string
  granted_at: string
  granted_by: string
}

interface VersionsTable {
  id: string
  shareable_id: string
  artifact_kind: ArtifactKind
  status: VersionStatus
  entrypoint_path: string
  r2_key: string
  size_bytes: number
  sha256: string
  fallback_to_index: Generated<number>
  created_by_id: string
  created_at: string
  published_at: string | null
}

interface VersionFilesTable {
  id: string
  version_id: string
  path: string
  r2_key: string
  mime_type: string
  size_bytes: number
  sha256: string
  scan_flags: string | null
  created_at: string
}

interface CommentThreadsTable {
  id: string
  shareable_id: string
  status: 'open' | 'resolved'
  created_by_id: string
  resolved_by_id: string | null
  resolved_at: string | null
  created_at: string
  updated_at: string
}

interface CommentMessagesTable {
  id: string
  thread_id: string
  body: string
  agent: string | null
  created_by_id: string
  created_at: string
  updated_at: string
}

interface CommentAnchorsTable {
  id: string
  thread_id: string
  version_id: string | null
  target_path: string
  quoted_text: string
  prefix_text: string
  suffix_text: string
  text_start: number
  text_end: number
  css_path: string | null
  created_at: string
}

interface ShareableViewerRecencyTable {
  shareable_id: string
  viewer_user_id: string
  first_viewed_at: string
  last_viewed_at: string
  version_seen_through_at: string | null
  comment_seen_through_at: string | null
  effective_view_count: Generated<number>
  viewed_title: string | null
  viewed_owner_name: string | null
}

interface SandboxTokenUsesTable {
  jti: string
  expires_at: string
}

interface SlackWorkspacesTable {
  id: string
  team_id: string
  team_name: string
  bot_user_id: string
  bot_token: string
  installed_by_user_id: string | null
  installed_at: string
  workspace_id: string | null
}

interface SlackUserLinksTable {
  id: string
  slack_team_id: string
  slack_user_id: string
  artifactshare_user_id: string
  linked_at: string
}

interface SlackNotifyNoncesTable {
  nonce: string
  created_at: string
}

interface ContainerSlackChannelsTable {
  container_id: string
  webhook_url: string
  channel_id: string
  channel_name: string
  slack_team_id: string
  slack_team_name: string
  configuration_url: string | null
  created_by: string | null
  updated_by: string | null
  created_at: string
  updated_at: string
}

interface SlackNotificationOutboxTable {
  id: string
  container_id: string
  shareable_id: string
  created_at: string
  claimed_at: string | null
  claim_token: string | null
}

interface McpArtifactPostsTable {
  id: string
  shareable_id: string
  user_id: string
  workspace_id: string
  client_id: string | null
  action: 'publish' | 'update'
  content_hash: string
  created_at: string
}

interface PendingSignupAnalyticsTable {
  user_id: string
  method: 'google' | 'microsoft' | 'email'
  workspace_created: number
  created_at: string
  claimed_at: string | null
  tracked_at: string | null
}

interface ArtifactKeysTable {
  id: string
  workspace_id: string
  owner_user_id: string
  container_id: string
  stable_key: string
  shareable_id: string
  created_at: string
  updated_at: string
}

interface ApiTokensTable {
  id: string
  user_id: string
  name: string
  token_hash: string
  created_at: string
  last_used_at: string | null
  revoked_at: string | null
}
