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
  workspace_migration_waits: WorkspaceMigrationWaitsTable
  workspace_migration_wait_alert_state: WorkspaceMigrationWaitAlertStateTable
  audit_events: AuditEventsTable
  security_audit_records: SecurityAuditRecordsTable
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
  agent_profiles: AgentProfilesTable
  bridge_authorities: BridgeAuthoritiesTable
  bridge_conversations: BridgeConversationsTable
  bridge_conversation_ids: BridgeConversationIdsTable
  bridge_requests: BridgeRequestsTable
  bridge_operations: BridgeOperationsTable
  bridge_dm_artifacts: BridgeDmArtifactsTable
  cli_family_authorities: CliFamilyAuthoritiesTable
  cli_session_authorities: CliSessionAuthoritiesTable
  deviceCode: DeviceCodeTable
  verifications: VerificationsTable
  shareables: ShareablesTable
  shareable_grants: ShareableGrantsTable
  access_requests: AccessRequestsTable
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

interface SecurityAuditRecordsTable {
  id: string
  workspace_id: string
  actor_type: string
  actor_id: string
  client_type: string
  client_id: string | null
  subject_type: string
  subject_id: string
  action: string
  created_at: string
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

interface WorkspaceMigrationWaitsTable {
  id: string
  user_id: string
  source_workspace_id: string
  target_workspace_id: string
  reason_codes: string
  generation: Generated<number>
  first_detected_at: string
  last_detected_at: string
  resolved_at: string | null
}

interface WorkspaceMigrationWaitAlertStateTable {
  id: number
  revision: number
  updated_at: string
  lease_until: string
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
  kind: Generated<'human' | 'bot'>
  bot_stopped_at: string | null
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
  device_id: string | null
  revocation_batch_id: string | null
}

interface CliRefreshSessionsTable {
  session_id: string
  credential_id: string
  family_id: string
}

interface AgentProfilesTable {
  id: string
  user_id: string
  workspace_id: string
  created_at: string
}

interface BridgeAuthoritiesTable {
  id: string
  workspace_id: string
  bot_user_id: string
  agent_profile_id: string
  source_kind: string
  source_installation_id: string
  external_workspace_id: string
  fallback_project_id: string | null
  created_at: string
  updated_at: string
}

interface BridgeConversationsTable {
  id: string
  bridge_authority_id: string
  project_id: string
  conversation_kind: 'public_channel' | 'private_channel'
  conversation_name: string | null
  privacy_ceiling: 'workspace' | 'private'
  privacy_epoch: Generated<number>
  created_at: string
  updated_at: string
}

interface BridgeConversationIdsTable {
  mapping_id: string
  bridge_authority_id: string
  external_conversation_id: string
  created_at: string
}

interface BridgeRequestsTable {
  bridge_authority_id: string
  request_id: string
  routing_class: 'channel' | 'dm'
  conversation_ids_json: string
  mapping_id: string | null
  requester_stable_id: string
  requester_verified_email: string
  stable_digest: string | null
  status: 'binding' | 'leased' | 'completed'
  lease_generation: string | null
  lease_expires_at: string | null
  result_artifact_id: string | null
  result_version_id: string | null
  mapping_created: Generated<number>
  project_created: Generated<number>
  created_at: string
  updated_at: string
}

interface BridgeOperationsTable {
  id: string
  bridge_authority_id: string
  request_id: string
  lease_generation: string
  operation: 'publish' | 'append' | 'update' | 'set_visibility'
  requester_stable_id: string
  requester_verified_email: string
  requester_display_name: string | null
  artifact_id: string
  version_id: string | null
  created_at: string
}

interface BridgeDmArtifactsTable {
  artifact_id: string
  bridge_authority_id: string
  requester_stable_id: string
  created_at: string
}

interface CliFamilyAuthoritiesTable {
  family_id: string
  user_id: string
  preset: 'unrestricted' | 'agent'
  workspace_id: string | null
  project_id: string | null
  project_name_snapshot: string | null
  agent_profile_id: string | null
  bridge_authority_id: Generated<string | null>
  approved_at: string | null
  device_name: string | null
  status: 'active' | 'revoked' | 'superseded'
  created_at: string
  updated_at: string
}

interface CliSessionAuthoritiesTable {
  session_id: string
  family_id: string | null
  kind: 'bootstrap' | 'family'
  preset: 'unrestricted' | 'agent'
  workspace_id: string | null
  project_id: string | null
  agent_profile_id: string | null
  expires_at: string | null
  bearer_only: Generated<number>
  created_at: string
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
  preset: 'unrestricted' | 'agent' | null
  deviceName: string | null
  approvalNonce: string | null
  selectedProjectId: string | null
  requestedProjectSelector: string | null
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
  created_by_agent_profile_id: string | null
}

interface ShareableGrantsTable {
  shareable_id: string
  granted_email: string
  granted_at: string
  granted_by: string
}

interface AccessRequestsTable {
  id: string
  shareable_id: string
  requester_user_id: string
  handler_user_id: string | null
  status: 'pending' | 'approved' | 'rejected'
  resolved_by_user_id: string | null
  resolution_scope: 'artifact' | 'project' | null
  created_at: string
  updated_at: string
  resolved_at: string | null
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
  created_by_agent_profile_id: Generated<string | null>
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
  created_by_agent_profile_id: string | null
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
  bot_scopes: string | null
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
  last_error_at: string | null
  last_error_status: number | null
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
