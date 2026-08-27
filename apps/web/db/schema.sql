-- ════════════════════════════════════════════════════════════════
-- Artifact Share - D1 schema (declarative source / human reference)
-- ════════════════════════════════════════════════════════════════
--
-- Source of truth: this file describes the *desired* database state.
-- Migration files remain the ordered history. The 0055 clean rebuild v2 is a
-- no-op migration marker; its actual production schema change is performed by
-- the dated operations runbook, then future migrations continue from there.
--
-- Conventions:
--   * Column names are snake_case. Kysely + CamelCasePlugin maps
--     them to camelCase at the application layer.
--   * Datetimes are stored as TEXT (ISO 8601, UTC, "Z"-suffixed).
--   * Booleans are INTEGER (0/1); SQLite has no native boolean.
--   * Every row in workspace-scoped tables MUST be filtered by
--     `workspace_id` at the query layer (server-derived).
--
-- ════════════════════════════════════════════════════════════════

PRAGMA foreign_keys = ON;

-- ────────────────────────────────────────────────
-- workspaces
-- ────────────────────────────────────────────────
-- Multi-tenancy boundary. Hosted-domain (`hd`) Google Workspaces
-- map 1:1 to a row; personal Gmail accounts get an individual
-- workspace with hd = NULL and name like "<email>'s workspace".

CREATE TABLE workspaces (
  id          TEXT PRIMARY KEY,                  -- nanoid
  hd          TEXT UNIQUE,                       -- Google Workspace domain (NULL for personal)
  name        TEXT NOT NULL,
  created_at  TEXT NOT NULL,                     -- ISO 8601 UTC
  plan                  TEXT NOT NULL DEFAULT 'free',
  storage_quota_bytes   INTEGER NOT NULL DEFAULT 104857600,
  self_upload_enabled   INTEGER NOT NULL DEFAULT 1,
  storage_used_bytes    INTEGER NOT NULL DEFAULT 0,
  storage_updated_at    TEXT NOT NULL DEFAULT '1970-01-01T00:00:00.000Z',
  ms_tenant_id                TEXT,
  email_domain                TEXT,
  stripe_customer_id          TEXT,
  stripe_subscription_id      TEXT,
  stripe_subscription_status  TEXT NOT NULL DEFAULT 'none',
  link_sharing_enabled        INTEGER NOT NULL DEFAULT 0
                              CHECK (link_sharing_enabled IN (0, 1)),
  external_posting_enabled    INTEGER NOT NULL DEFAULT 0
                              CHECK (external_posting_enabled IN (0, 1)),
  link_expiry_default_days    INTEGER
                              DEFAULT 30
                              CHECK (
                                link_expiry_default_days IS NULL
                                OR (link_expiry_default_days BETWEEN 1 AND 365)
                              ),
  link_expiry_max_days        INTEGER
                              DEFAULT 90
                              CHECK (
                                link_expiry_max_days IS NULL
                                OR (
                                  link_expiry_max_days BETWEEN 1 AND 365
                                  AND link_expiry_default_days IS NOT NULL
                                  AND link_expiry_default_days <= link_expiry_max_days
                                )
                              )
);
CREATE UNIQUE INDEX workspaces_ms_tenant_id
  ON workspaces(ms_tenant_id);
CREATE UNIQUE INDEX workspaces_stripe_customer_id
  ON workspaces(stripe_customer_id);
CREATE UNIQUE INDEX workspaces_stripe_subscription_id
  ON workspaces(stripe_subscription_id);

CREATE TABLE workspace_domain_claims (
  domain             TEXT PRIMARY KEY,
  workspace_id       TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  source             TEXT NOT NULL CHECK (source IN ('google_hd', 'microsoft_verified_domain')),
  provider_tenant_id TEXT,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL
);
CREATE INDEX workspace_domain_claims_workspace_id
  ON workspace_domain_claims(workspace_id);

-- ────────────────────────────────────────────────
-- users (better-auth standard + Artifact Share extensions)
-- ────────────────────────────────────────────────

CREATE TABLE users (
  id              TEXT PRIMARY KEY,
  email           TEXT NOT NULL UNIQUE,
  email_verified  INTEGER NOT NULL DEFAULT 0,    -- 0 / 1
  name            TEXT,
  image           TEXT,                          -- Google profile picture URL
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  -- ↓ Artifact Share extensions
  workspace_id    TEXT NOT NULL REFERENCES workspaces(id),
  locale          TEXT,
  -- 'human' | 'bot'. Bots are workspace-scoped automation members whose only
  -- credentials are restricted agent-preset CLI families. Immutable after
  -- creation (users_kind_immutable trigger).
  kind            TEXT NOT NULL DEFAULT 'human' CHECK (kind IN ('human', 'bot')),
  -- Stop time for bot users (soft stop; the row is never deleted). Always
  -- NULL for humans.
  bot_stopped_at  TEXT
);
CREATE INDEX users_workspace_id ON users(workspace_id);
-- Active bots only: a stopped bot releases its name for reuse.
CREATE UNIQUE INDEX users_active_bot_name
  ON users(workspace_id, name)
  WHERE kind = 'bot' AND bot_stopped_at IS NULL;

-- kind is fixed at creation; flipping a credentialed human to 'bot' (or back)
-- via direct SQL would fabricate states the application never creates.
CREATE TRIGGER users_kind_immutable
BEFORE UPDATE OF kind ON users
WHEN OLD.kind <> NEW.kind
BEGIN
  SELECT RAISE(ABORT, 'users.kind is immutable');
END;

CREATE TABLE workspace_members (
  workspace_id          TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id               TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role                  TEXT NOT NULL DEFAULT 'member'
                        CHECK (role IN ('owner', 'admin', 'member')),
  status                TEXT NOT NULL DEFAULT 'active'
                        CHECK (status IN ('active', 'removed')),
  first_contributed_at  TEXT,
  last_contributed_at   TEXT,
  pending_uploads       INTEGER NOT NULL DEFAULT 0,
  removed_at            TEXT,
  removed_by            TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL,
  PRIMARY KEY (workspace_id, user_id)
);
CREATE INDEX workspace_members_user ON workspace_members(user_id, status);
CREATE INDEX workspace_members_workspace_status ON workspace_members(workspace_id, status);
CREATE UNIQUE INDEX workspace_members_single_owner
  ON workspace_members(workspace_id) WHERE role = 'owner';

CREATE TABLE workspace_migration_waits (
  id                   TEXT PRIMARY KEY,
  user_id              TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source_workspace_id  TEXT NOT NULL,
  target_workspace_id  TEXT NOT NULL,
  reason_codes         TEXT NOT NULL
                       CHECK (json_valid(reason_codes) AND json_type(reason_codes) = 'array'),
  generation           INTEGER NOT NULL DEFAULT 1 CHECK (generation > 0),
  first_detected_at    TEXT NOT NULL,
  last_detected_at     TEXT NOT NULL,
  resolved_at          TEXT,
  UNIQUE (user_id, target_workspace_id)
);
CREATE INDEX workspace_migration_waits_active
  ON workspace_migration_waits(resolved_at, last_detected_at DESC);

CREATE TABLE workspace_migration_wait_alert_state (
  id          INTEGER PRIMARY KEY CHECK (id = 1),
  revision    INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  updated_at  TEXT NOT NULL,
  lease_until TEXT NOT NULL
);
INSERT INTO workspace_migration_wait_alert_state (id, revision, updated_at, lease_until)
VALUES (1, 0, '1970-01-01T00:00:00.000Z', '1970-01-01T00:00:00.000Z');

-- ────────────────────────────────────────────────
-- billing (Stripe)
-- ────────────────────────────────────────────────

CREATE TABLE billing_webhook_events (
  stripe_event_id TEXT PRIMARY KEY,
  event_type      TEXT NOT NULL,
  received_at     TEXT NOT NULL,
  processed_at    TEXT,
  error           TEXT
);

CREATE TABLE workspace_storage_daily_usage (
  workspace_id        TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  date                TEXT NOT NULL,            -- 'YYYY-MM-DD' (UTC)
  used_bytes          INTEGER NOT NULL,
  included_bytes      INTEGER NOT NULL,
  billable_overage_gb REAL NOT NULL,
  PRIMARY KEY (workspace_id, date)
);

CREATE TABLE billing_overage_charges (
  workspace_id           TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  month                  TEXT NOT NULL,           -- 'YYYY-MM' (UTC)
  overage_gb_month       INTEGER NOT NULL,
  status                 TEXT NOT NULL CHECK (status IN ('pending', 'completed', 'failed')),
  stripe_invoice_item_id TEXT,
  stripe_invoice_id      TEXT,
  created_at             TEXT NOT NULL,
  processed_at           TEXT,
  PRIMARY KEY (workspace_id, month)
);

-- ────────────────────────────────────────────────
-- artifact_containers
-- ────────────────────────────────────────────────

CREATE TABLE artifact_containers (
  id              TEXT PRIMARY KEY,
  workspace_id    TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  kind            TEXT NOT NULL CHECK (kind IN ('inbox', 'project')),
  owner_user_id   TEXT REFERENCES users(id) ON DELETE CASCADE,
  created_by_id   TEXT REFERENCES users(id) ON DELETE SET NULL,
  name            TEXT NOT NULL,
  description     TEXT,
  archived_at     TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  base_visibility TEXT NOT NULL DEFAULT 'workspace'                                     -- project の公開範囲のベース (kind=project のみ使用)
    CHECK (base_visibility IN ('workspace', 'private')),
  CHECK (
    (kind = 'inbox' AND owner_user_id IS NOT NULL) OR
    (kind = 'project')
  )
);
CREATE INDEX artifact_containers_workspace_kind_updated
  ON artifact_containers(workspace_id, kind, archived_at, updated_at DESC);
CREATE UNIQUE INDEX artifact_containers_active_project_name_unique
  ON artifact_containers(workspace_id, name COLLATE NOCASE)
  WHERE kind = 'project' AND archived_at IS NULL;
CREATE UNIQUE INDEX artifact_containers_one_inbox_per_owner
  ON artifact_containers(workspace_id, owner_user_id)
  WHERE kind = 'inbox';

CREATE TABLE project_share_defaults (
  id                    TEXT PRIMARY KEY,
  project_container_id  TEXT NOT NULL REFERENCES artifact_containers(id) ON DELETE CASCADE,
  email                 TEXT NOT NULL,
  role                  TEXT NOT NULL DEFAULT 'viewer' CHECK (role IN ('viewer', 'contributor', 'manager')),
  display_name          TEXT,
  created_by_id         TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL,
  UNIQUE (project_container_id, email)
);
CREATE INDEX project_share_defaults_email
  ON project_share_defaults(email);
CREATE TRIGGER project_share_defaults_project_only_insert
BEFORE INSERT ON project_share_defaults
WHEN NOT EXISTS (
  SELECT 1
  FROM artifact_containers
  WHERE id = NEW.project_container_id
    AND kind = 'project'
)
BEGIN
  SELECT RAISE(ABORT, 'project_share_defaults requires project container');
END;
CREATE TRIGGER project_share_defaults_project_only_update
BEFORE UPDATE OF project_container_id ON project_share_defaults
WHEN NOT EXISTS (
  SELECT 1
  FROM artifact_containers
  WHERE id = NEW.project_container_id
    AND kind = 'project'
)
BEGIN
  SELECT RAISE(ABORT, 'project_share_defaults requires project container');
END;

CREATE TABLE project_members (
  container_id TEXT NOT NULL REFERENCES artifact_containers(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  joined_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  PRIMARY KEY (container_id, user_id)
);
CREATE INDEX project_members_user ON project_members(user_id);
CREATE TRIGGER project_members_project_only_insert
BEFORE INSERT ON project_members
WHEN NOT EXISTS (SELECT 1 FROM artifact_containers WHERE id = NEW.container_id AND kind = 'project')
BEGIN SELECT RAISE(ABORT, 'project_members requires project container'); END;
CREATE TRIGGER project_members_project_only_update
BEFORE UPDATE OF container_id ON project_members
WHEN NOT EXISTS (SELECT 1 FROM artifact_containers WHERE id = NEW.container_id AND kind = 'project')
BEGIN SELECT RAISE(ABORT, 'project_members requires project container'); END;

-- ────────────────────────────────────────────────
-- accounts (better-auth standard)
-- Provider linkage. Token columns remain nullable for better-auth
-- compatibility, but Artifact Share does not write OAuth tokens.
-- ────────────────────────────────────────────────

CREATE TABLE accounts (
  id                        TEXT PRIMARY KEY,
  user_id                   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider_id               TEXT NOT NULL,
  account_id                TEXT NOT NULL,        -- provider's durable account id
  access_token              TEXT,
  access_token_expires_at   TEXT,
  refresh_token             TEXT,
  refresh_token_expires_at  TEXT,
  id_token                  TEXT,
  scope                     TEXT,
  password                  TEXT,
  created_at                TEXT NOT NULL,
  updated_at                TEXT NOT NULL,
  UNIQUE (provider_id, account_id)
);
CREATE INDEX accounts_user_id ON accounts(user_id);

-- ────────────────────────────────────────────────
-- sessions (better-auth standard)
-- ────────────────────────────────────────────────

CREATE TABLE sessions (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token       TEXT NOT NULL UNIQUE,
  expires_at  TEXT NOT NULL,
  ip_address  TEXT,
  user_agent  TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
CREATE INDEX sessions_user_id ON sessions(user_id);

-- ────────────────────────────────────────────────
-- cli_refresh_credentials
-- CLI profile credentials that can mint a new session token. The plaintext
-- credential is returned only at issue time; the database stores a hash.
-- ────────────────────────────────────────────────

CREATE TABLE cli_refresh_credentials (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash    TEXT NOT NULL UNIQUE,
  expires_at    TEXT NOT NULL,
  revoked_at    TEXT,
  created_at    TEXT NOT NULL,
  last_used_at  TEXT,
  family_id     TEXT,
  replaced_by_id TEXT,
  rotation_request_hash TEXT,
  rotation_retry_until TEXT,
  rotation_session_id TEXT,
  device_name TEXT,
  device_id TEXT,
  revocation_batch_id TEXT
);
CREATE INDEX cli_refresh_credentials_user_id ON cli_refresh_credentials(user_id);
CREATE INDEX cli_refresh_credentials_family_id ON cli_refresh_credentials(family_id);
CREATE INDEX cli_refresh_credentials_rotation_retry_until
  ON cli_refresh_credentials(rotation_retry_until)
  WHERE rotation_request_hash IS NOT NULL
    AND revoked_at IS NOT NULL;
CREATE TABLE cli_refresh_sessions (
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  credential_id TEXT NOT NULL REFERENCES cli_refresh_credentials(id) ON DELETE CASCADE,
  family_id TEXT NOT NULL,
  PRIMARY KEY (session_id, family_id)
);
CREATE INDEX cli_refresh_sessions_family_id ON cli_refresh_sessions(family_id);

CREATE TABLE agent_profiles (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL,
  UNIQUE (user_id, workspace_id)
);
CREATE TABLE cli_family_authorities (
  family_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  preset TEXT NOT NULL CHECK (preset IN ('unrestricted', 'agent')),
  workspace_id TEXT REFERENCES workspaces(id) ON DELETE RESTRICT,
  project_id TEXT REFERENCES artifact_containers(id) ON DELETE RESTRICT,
  project_name_snapshot TEXT,
  agent_profile_id TEXT REFERENCES agent_profiles(id) ON DELETE RESTRICT,
  bridge_authority_id TEXT REFERENCES bridge_authorities(id) ON DELETE RESTRICT,
  approved_at TEXT,
  device_name TEXT,
  status TEXT NOT NULL CHECK (status IN ('active', 'revoked', 'superseded')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  -- project_id may be NULL for agent presets: project deletion detaches
  -- non-live agent authorities from the project (project_name_snapshot stays).
  CHECK ((preset = 'unrestricted' AND workspace_id IS NULL AND project_id IS NULL AND agent_profile_id IS NULL) OR (preset = 'agent' AND workspace_id IS NOT NULL AND agent_profile_id IS NOT NULL))
);
CREATE INDEX cli_family_authorities_user_id ON cli_family_authorities(user_id);
CREATE INDEX cli_family_authorities_agent_profile_id ON cli_family_authorities(agent_profile_id);
CREATE INDEX cli_family_authorities_bridge_authority_id
  ON cli_family_authorities(bridge_authority_id);

-- Bots only ever hold restricted agent-preset credential families.
CREATE TRIGGER cli_family_authorities_bot_agent_only_insert
BEFORE INSERT ON cli_family_authorities
WHEN NEW.preset <> 'agent'
  AND EXISTS (SELECT 1 FROM users WHERE id = NEW.user_id AND kind = 'bot')
BEGIN
  SELECT RAISE(ABORT, 'bot users only allow agent preset authorities');
END;
CREATE TRIGGER cli_family_authorities_bot_agent_only_update
BEFORE UPDATE ON cli_family_authorities
WHEN NEW.preset <> 'agent'
  AND EXISTS (SELECT 1 FROM users WHERE id = NEW.user_id AND kind = 'bot')
BEGIN
  SELECT RAISE(ABORT, 'bot users only allow agent preset authorities');
END;
CREATE TABLE cli_session_authorities (
  session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  family_id TEXT REFERENCES cli_family_authorities(family_id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('bootstrap', 'family')),
  preset TEXT NOT NULL CHECK (preset IN ('unrestricted', 'agent')),
  workspace_id TEXT REFERENCES workspaces(id) ON DELETE RESTRICT,
  project_id TEXT REFERENCES artifact_containers(id) ON DELETE RESTRICT,
  agent_profile_id TEXT REFERENCES agent_profiles(id) ON DELETE RESTRICT,
  expires_at TEXT,
  bearer_only INTEGER NOT NULL DEFAULT 1 CHECK (bearer_only IN (0, 1)),
  created_at TEXT NOT NULL,
  CHECK ((kind = 'bootstrap' AND family_id IS NULL AND expires_at IS NOT NULL) OR (kind = 'family' AND family_id IS NOT NULL AND expires_at IS NULL))
);
CREATE INDEX cli_session_authorities_family_id ON cli_session_authorities(family_id);

CREATE TABLE bridge_authorities (
  id                       TEXT PRIMARY KEY,
  workspace_id             TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  bot_user_id              TEXT NOT NULL UNIQUE REFERENCES users(id) ON DELETE RESTRICT,
  agent_profile_id         TEXT NOT NULL UNIQUE REFERENCES agent_profiles(id) ON DELETE RESTRICT,
  source_kind              TEXT NOT NULL,
  source_installation_id   TEXT NOT NULL,
  external_workspace_id    TEXT NOT NULL,
  fallback_project_id      TEXT REFERENCES artifact_containers(id) ON DELETE SET NULL,
  created_at               TEXT NOT NULL,
  updated_at               TEXT NOT NULL,
  UNIQUE (workspace_id, source_kind, source_installation_id, external_workspace_id),
  CHECK (source_kind = trim(source_kind) AND length(source_kind) BETWEEN 1 AND 80),
  CHECK (source_installation_id = trim(source_installation_id) AND length(source_installation_id) BETWEEN 1 AND 200),
  CHECK (external_workspace_id = trim(external_workspace_id) AND length(external_workspace_id) BETWEEN 1 AND 200)
);
CREATE INDEX bridge_authorities_fallback_project_id
  ON bridge_authorities(fallback_project_id);

CREATE TABLE bridge_conversations (
  id                       TEXT PRIMARY KEY,
  bridge_authority_id      TEXT NOT NULL REFERENCES bridge_authorities(id) ON DELETE RESTRICT,
  project_id               TEXT NOT NULL UNIQUE REFERENCES artifact_containers(id) ON DELETE CASCADE,
  conversation_kind        TEXT NOT NULL CHECK (conversation_kind IN ('public_channel', 'private_channel')),
  conversation_name        TEXT,
  privacy_ceiling          TEXT NOT NULL CHECK (privacy_ceiling IN ('workspace', 'private')),
  privacy_epoch            INTEGER NOT NULL DEFAULT 0 CHECK (privacy_epoch IN (0, 1)),
  created_at               TEXT NOT NULL,
  updated_at               TEXT NOT NULL,
  UNIQUE (id, bridge_authority_id)
);
CREATE INDEX bridge_conversations_authority_updated
  ON bridge_conversations(bridge_authority_id, updated_at DESC);

CREATE TRIGGER bridge_conversations_privacy_monotonic
BEFORE UPDATE OF privacy_ceiling, privacy_epoch ON bridge_conversations
WHEN (OLD.privacy_ceiling = 'private' AND NEW.privacy_ceiling <> 'private')
  OR NEW.privacy_epoch < OLD.privacy_epoch
BEGIN
  SELECT RAISE(ABORT, 'bridge conversation privacy cannot widen');
END;

CREATE TABLE bridge_conversation_ids (
  mapping_id                TEXT NOT NULL,
  bridge_authority_id       TEXT NOT NULL,
  external_conversation_id  TEXT NOT NULL,
  created_at                TEXT NOT NULL,
  PRIMARY KEY (bridge_authority_id, external_conversation_id),
  FOREIGN KEY (mapping_id, bridge_authority_id)
    REFERENCES bridge_conversations(id, bridge_authority_id) ON DELETE CASCADE
);
CREATE INDEX bridge_conversation_ids_mapping_id
  ON bridge_conversation_ids(mapping_id);

CREATE TABLE bridge_requests (
  bridge_authority_id       TEXT NOT NULL REFERENCES bridge_authorities(id) ON DELETE RESTRICT,
  request_id                TEXT NOT NULL,
  routing_class             TEXT NOT NULL CHECK (routing_class IN ('channel', 'dm')),
  conversation_ids_json     TEXT NOT NULL,
  mapping_id                TEXT REFERENCES bridge_conversations(id) ON DELETE SET NULL,
  requester_stable_id       TEXT NOT NULL,
  requester_verified_email  TEXT NOT NULL,
  stable_digest             TEXT,
  status                    TEXT NOT NULL CHECK (status IN ('binding', 'leased', 'completed')),
  lease_generation          TEXT,
  lease_expires_at          TEXT,
  result_artifact_id        TEXT, -- tombstone survives normal artifact deletion
  result_version_id         TEXT, -- tombstone survives normal version deletion
  mapping_created           INTEGER NOT NULL DEFAULT 0 CHECK (mapping_created IN (0, 1)),
  project_created           INTEGER NOT NULL DEFAULT 0 CHECK (project_created IN (0, 1)),
  created_at                TEXT NOT NULL,
  updated_at                TEXT NOT NULL,
  PRIMARY KEY (bridge_authority_id, request_id),
  UNIQUE (bridge_authority_id, request_id, lease_generation),
  CHECK (
    (status = 'binding' AND stable_digest IS NULL AND lease_generation IS NULL AND lease_expires_at IS NULL)
    OR (status = 'leased' AND stable_digest IS NOT NULL AND lease_generation IS NOT NULL AND lease_expires_at IS NOT NULL)
    OR (status = 'completed' AND stable_digest IS NOT NULL AND lease_generation IS NOT NULL AND lease_expires_at IS NOT NULL AND result_artifact_id IS NOT NULL)
  )
);
CREATE INDEX bridge_requests_mapping_id ON bridge_requests(mapping_id);
CREATE INDEX bridge_requests_lease_expiry
  ON bridge_requests(status, lease_expires_at);

-- ────────────────────────────────────────────────
-- deviceCode (better-auth device authorization plugin)
-- Column names follow better-auth's default camelCase so the adapter's
-- generated SQL matches without a field mapping.
-- ────────────────────────────────────────────────

CREATE TABLE deviceCode (
  id               TEXT PRIMARY KEY,
  deviceCode       TEXT NOT NULL UNIQUE,
  userCode         TEXT NOT NULL UNIQUE,
  userId           TEXT REFERENCES users(id) ON DELETE CASCADE,
  expiresAt        TEXT NOT NULL,
  status           TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'denied')),
  lastPolledAt     TEXT,
  pollingInterval  INTEGER,
  clientId         TEXT,
  scope            TEXT,
  preset           TEXT CHECK (preset IS NULL OR preset IN ('unrestricted', 'agent')),
  deviceName       TEXT,
  approvalNonce    TEXT,
  selectedProjectId TEXT,
  requestedProjectSelector TEXT CHECK (
    requestedProjectSelector IS NULL
    OR (
      requestedProjectSelector = trim(requestedProjectSelector)
      AND length(requestedProjectSelector) BETWEEN 1 AND 120
    )
  )
);
CREATE INDEX deviceCode_userId ON deviceCode(userId);

-- ────────────────────────────────────────────────
-- verifications (better-auth standard)
-- Used for email verification flows, OAuth state storage, etc.
-- ────────────────────────────────────────────────

CREATE TABLE verifications (
  id          TEXT PRIMARY KEY,
  identifier  TEXT NOT NULL,
  value       TEXT NOT NULL,
  expires_at  TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
CREATE INDEX verifications_identifier ON verifications(identifier);

-- ────────────────────────────────────────────────
-- shareables / versions / version_files
-- Upload-first model. 1 share = 1 URL slug = 1 shareables row.
-- Each upload / update is a new versions row; current_version_id picks
-- the visible one. Artifact bodies are stored in R2.
-- ────────────────────────────────────────────────

CREATE TABLE shareables (
  id                         TEXT PRIMARY KEY,                                        -- DNS-safe nanoid (10 chars). /a/<id> と <id>.sandbox.artifactshare.com で兼用
  workspace_id               TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  owner_user_id              TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  slug                       TEXT,                                                    -- Phase 2 @handle/slug alias; NULL for now
  name                       TEXT NOT NULL,
  derived_title              TEXT,
  title_override             TEXT,
  description                TEXT,
  artifact_kind              TEXT NOT NULL,                                           -- markdown_page | html_page | static_site | spa | workspace_app
  visibility                 TEXT NOT NULL                                            -- private | workspace | project | link
    CHECK (visibility IN ('private', 'workspace', 'project', 'link')),
  current_version_id         TEXT,                                                    -- FK to versions.id, populated after publish
  view_count                 INTEGER NOT NULL DEFAULT 0,                              -- display counter; best-effort deduped by VIEW_DEDUP KV
  created_at                 TEXT NOT NULL,
  updated_at                 TEXT NOT NULL,
  last_accessed_at           TEXT,
  container_id               TEXT NOT NULL REFERENCES artifact_containers(id) ON DELETE SET NULL -- artifact_containers_no_delete_with_shareables prevents the SET NULL path
, link_expires_at TEXT, created_by_agent_profile_id TEXT REFERENCES agent_profiles(id) ON DELETE RESTRICT);
CREATE INDEX shareables_workspace_owner_created
  ON shareables(workspace_id, owner_user_id, created_at DESC);
CREATE UNIQUE INDEX shareables_workspace_slug
  ON shareables(workspace_id, slug) WHERE slug IS NOT NULL;
CREATE INDEX shareables_container_created
  ON shareables(container_id, created_at DESC);
CREATE INDEX shareables_container_updated
  ON shareables(container_id, updated_at DESC, id DESC);
CREATE INDEX shareables_workspace_owner_updated
  ON shareables(workspace_id, owner_user_id, updated_at DESC, id DESC);
CREATE INDEX shareables_workspace_updated
  ON shareables(workspace_id, updated_at DESC, id DESC);
CREATE INDEX shareables_created_by_agent_profile_id ON shareables(created_by_agent_profile_id);

CREATE TRIGGER artifact_containers_no_delete_with_shareables
BEFORE DELETE ON artifact_containers
WHEN EXISTS (
  SELECT 1
  FROM shareables
  WHERE shareables.container_id = OLD.id
)
BEGIN
  SELECT RAISE(ABORT, 'artifact_containers with shareables cannot be deleted');
END;

CREATE TABLE shareable_grants (
  shareable_id  TEXT NOT NULL REFERENCES shareables(id) ON DELETE CASCADE,
  granted_email TEXT NOT NULL,
  granted_at    TEXT NOT NULL,
  granted_by    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (shareable_id, granted_email)
);
CREATE INDEX idx_shareable_grants_email ON shareable_grants(granted_email);

CREATE TABLE versions (
  id                        TEXT PRIMARY KEY,                                         -- migration-generated hex or app-side nanoid
  shareable_id              TEXT NOT NULL REFERENCES shareables(id) ON DELETE CASCADE,
  artifact_kind             TEXT NOT NULL,
  status                    TEXT NOT NULL,                                            -- uploading | scanning | published | blocked | failed
  entrypoint_path           TEXT NOT NULL,                                            -- /index.html or /note.md
  r2_key                    TEXT NOT NULL,
  size_bytes                INTEGER NOT NULL,
  sha256                    TEXT NOT NULL,
  fallback_to_index         INTEGER NOT NULL DEFAULT 0,                               -- 0 / 1
  created_by_id             TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at                TEXT NOT NULL,
  published_at              TEXT
);
CREATE INDEX versions_shareable_id ON versions(shareable_id);
CREATE INDEX versions_r2_key ON versions(r2_key);

CREATE TABLE bridge_operations (
  id                         TEXT PRIMARY KEY,
  bridge_authority_id        TEXT NOT NULL,
  request_id                 TEXT NOT NULL,
  lease_generation           TEXT NOT NULL,
  operation                  TEXT NOT NULL CHECK (operation IN ('publish', 'append', 'update', 'set_visibility')),
  requester_stable_id        TEXT NOT NULL,
  requester_verified_email   TEXT NOT NULL,
  requester_display_name     TEXT,
  artifact_id                TEXT NOT NULL REFERENCES shareables(id) ON DELETE CASCADE,
  version_id                 TEXT REFERENCES versions(id) ON DELETE CASCADE,
  created_at                 TEXT NOT NULL,
  UNIQUE (bridge_authority_id, request_id),
  FOREIGN KEY (bridge_authority_id, request_id, lease_generation)
    REFERENCES bridge_requests(bridge_authority_id, request_id, lease_generation) ON DELETE RESTRICT,
  CHECK ((operation = 'set_visibility') = (version_id IS NULL))
);
CREATE INDEX bridge_operations_artifact_created
  ON bridge_operations(artifact_id, created_at DESC);
CREATE UNIQUE INDEX bridge_operations_version_id
  ON bridge_operations(version_id) WHERE version_id IS NOT NULL;

CREATE TRIGGER bridge_operations_private_grant_insert
BEFORE INSERT ON bridge_operations
WHEN EXISTS (
  SELECT 1 FROM shareables
  WHERE id = NEW.artifact_id AND visibility = 'private'
)
AND NOT EXISTS (
  SELECT 1 FROM shareable_grants
  WHERE shareable_id = NEW.artifact_id
    AND lower(granted_email) = lower(NEW.requester_verified_email)
)
BEGIN
  SELECT RAISE(ABORT, 'private bridge artifact requires requester grant');
END;

CREATE TABLE bridge_dm_artifacts (
  artifact_id          TEXT PRIMARY KEY REFERENCES shareables(id) ON DELETE CASCADE,
  bridge_authority_id  TEXT NOT NULL REFERENCES bridge_authorities(id) ON DELETE RESTRICT,
  requester_stable_id  TEXT NOT NULL,
  created_at           TEXT NOT NULL
);
CREATE INDEX bridge_dm_artifacts_authority_requester
  ON bridge_dm_artifacts(bridge_authority_id, requester_stable_id);

-- ────────────────────────────────────────────────
-- version_files
-- static_site bundle のファイル一覧。1 version = 複数 row。
-- path は `/` 始まり、r2_key は <workspaceId>/<shareableId>/<versionId>/<path 先頭/除去> のフル key。
-- scan_flags は {"warnings":[...]} 形式の JSON。
-- ────────────────────────────────────────────────

CREATE TABLE version_files (
  id          TEXT PRIMARY KEY,
  version_id  TEXT NOT NULL REFERENCES versions(id) ON DELETE CASCADE,
  path        TEXT NOT NULL,
  r2_key      TEXT NOT NULL,
  mime_type   TEXT NOT NULL,
  size_bytes  INTEGER NOT NULL,
  sha256      TEXT NOT NULL,
  scan_flags  TEXT,
  created_at  TEXT NOT NULL,
  UNIQUE (version_id, path)
);
CREATE INDEX version_files_version_id ON version_files(version_id);

-- ────────────────────────────────────────────────
-- comments
-- ────────────────────────────────────────────────
-- comment_threads は成果物上の 1 会話。本文範囲に紐づく情報は
-- 後続の comment_anchors に分け、成果物全体コメントは anchor を持たない。

CREATE TABLE comment_threads (
  id              TEXT PRIMARY KEY,
  shareable_id    TEXT NOT NULL REFERENCES shareables(id) ON DELETE CASCADE,
  status          TEXT NOT NULL CHECK (status IN ('open', 'resolved')),
  created_by_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  resolved_by_id  TEXT REFERENCES users(id) ON DELETE SET NULL,
  resolved_at     TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
CREATE INDEX comment_threads_shareable_status_updated
  ON comment_threads(shareable_id, status, updated_at DESC);

CREATE TABLE comment_messages (
  id             TEXT PRIMARY KEY,
  thread_id      TEXT NOT NULL REFERENCES comment_threads(id) ON DELETE CASCADE,
  body           TEXT NOT NULL,
  agent          TEXT CHECK(agent IS NULL OR length(agent) <= 30),
  created_by_id  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_by_agent_profile_id TEXT REFERENCES agent_profiles(id) ON DELETE RESTRICT,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);
CREATE INDEX comment_messages_thread_created
  ON comment_messages(thread_id, created_at ASC);
CREATE INDEX comment_messages_created_by_agent_profile_id ON comment_messages(created_by_agent_profile_id);

CREATE TABLE comment_anchors (
  id            TEXT PRIMARY KEY,
  thread_id     TEXT NOT NULL UNIQUE REFERENCES comment_threads(id) ON DELETE CASCADE,
  version_id    TEXT REFERENCES versions(id) ON DELETE SET NULL,
  target_path   TEXT NOT NULL,
  quoted_text   TEXT NOT NULL,
  prefix_text   TEXT NOT NULL,
  suffix_text   TEXT NOT NULL,
  text_start    INTEGER NOT NULL,
  text_end      INTEGER NOT NULL,
  css_path      TEXT,
  created_at    TEXT NOT NULL
);
CREATE INDEX comment_anchors_version_path
  ON comment_anchors(version_id, target_path);

-- ────────────────────────────────────────────────
-- shareable_viewer_recency
-- Current per-user recency for signed-in viewers. Anonymous viewers are not
-- listed here; their views only participate in the display view_count dedup.
-- ────────────────────────────────────────────────

CREATE TABLE shareable_viewer_recency (
  shareable_id         TEXT NOT NULL REFERENCES shareables(id) ON DELETE CASCADE,
  viewer_user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  first_viewed_at      TEXT NOT NULL,
  last_viewed_at       TEXT NOT NULL,
  version_seen_through_at TEXT,
  comment_seen_through_at TEXT,
  effective_view_count INTEGER NOT NULL DEFAULT 0,
  viewed_title         TEXT,
  viewed_owner_name    TEXT,
  PRIMARY KEY (shareable_id, viewer_user_id)
);
CREATE INDEX shareable_viewer_recency_viewer_time
  ON shareable_viewer_recency(viewer_user_id, last_viewed_at DESC);
CREATE INDEX shareable_viewer_recency_shareable_time
  ON shareable_viewer_recency(shareable_id, last_viewed_at DESC, viewer_user_id DESC);

CREATE TABLE sandbox_token_uses (
  jti         TEXT PRIMARY KEY,
  expires_at  TEXT NOT NULL
);
CREATE INDEX sandbox_token_uses_expires_at ON sandbox_token_uses(expires_at);

-- ────────────────────────────────────────────────
-- Slack App Unfurl
-- ────────────────────────────────────────────────

CREATE TABLE slack_workspaces (
  id                    TEXT PRIMARY KEY,
  team_id               TEXT NOT NULL UNIQUE,
  team_name             TEXT NOT NULL,
  bot_user_id           TEXT NOT NULL,
  bot_token             TEXT NOT NULL,
  installed_by_user_id  TEXT REFERENCES users(id) ON DELETE SET NULL,
  installed_at          TEXT NOT NULL,
  workspace_id          TEXT REFERENCES workspaces(id) ON DELETE CASCADE
);
CREATE INDEX slack_workspaces_workspace_id ON slack_workspaces(workspace_id);

CREATE TABLE slack_user_links (
  id                    TEXT PRIMARY KEY,
  slack_team_id         TEXT NOT NULL REFERENCES slack_workspaces(team_id) ON DELETE CASCADE,
  slack_user_id         TEXT NOT NULL,
  artifactshare_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  linked_at             TEXT NOT NULL,
  UNIQUE (slack_team_id, slack_user_id)
);
CREATE INDEX slack_user_links_artifactshare_user_id
  ON slack_user_links(artifactshare_user_id);

CREATE TABLE container_slack_channels (
  container_id       TEXT PRIMARY KEY REFERENCES artifact_containers(id) ON DELETE CASCADE,
  webhook_url        TEXT NOT NULL,
  channel_id         TEXT NOT NULL,
  channel_name       TEXT NOT NULL,
  slack_team_id      TEXT NOT NULL,
  slack_team_name    TEXT NOT NULL,
  configuration_url   TEXT,
  created_by         TEXT REFERENCES users(id) ON DELETE SET NULL,
  updated_by         TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL,
  last_error_at      TEXT,
  last_error_status  INTEGER,
  CHECK (
    (last_error_at IS NULL AND last_error_status IS NULL)
    OR (last_error_at IS NOT NULL AND last_error_status = 404)
  )
);
CREATE TRIGGER container_slack_channels_project_only_insert
BEFORE INSERT ON container_slack_channels
WHEN NOT EXISTS (SELECT 1 FROM artifact_containers WHERE id = NEW.container_id AND kind = 'project')
BEGIN SELECT RAISE(ABORT, 'container_slack_channels requires project container'); END;
CREATE TRIGGER container_slack_channels_project_only_update
BEFORE UPDATE OF container_id ON container_slack_channels
WHEN NOT EXISTS (SELECT 1 FROM artifact_containers WHERE id = NEW.container_id AND kind = 'project')
BEGIN SELECT RAISE(ABORT, 'container_slack_channels requires project container'); END;

CREATE TABLE slack_notify_nonces (nonce TEXT PRIMARY KEY, created_at TEXT NOT NULL);

CREATE TABLE slack_notification_outbox (
  id           TEXT PRIMARY KEY,
  container_id TEXT NOT NULL REFERENCES artifact_containers(id) ON DELETE CASCADE,
  shareable_id TEXT NOT NULL UNIQUE REFERENCES shareables(id) ON DELETE CASCADE,
  created_at   TEXT NOT NULL,
  claimed_at   TEXT,
  claim_token  TEXT
);

-- ────────────────────────────────────────────────
-- OAuth 2.1 authorization server (@better-auth/oauth-provider) + JWT signing
-- keys (better-auth jwt plugin). Column names follow better-auth's default
-- camelCase so the adapter's generated SQL matches without a field mapping.
-- ────────────────────────────────────────────────

CREATE TABLE jwks (
  id          TEXT PRIMARY KEY,
  publicKey   TEXT NOT NULL,
  privateKey  TEXT NOT NULL,
  createdAt   TEXT NOT NULL,
  expiresAt   TEXT
);

CREATE TABLE oauthClient (
  id                       TEXT PRIMARY KEY,
  clientId                 TEXT NOT NULL UNIQUE,
  clientSecret             TEXT,
  disabled                 INTEGER,
  skipConsent              INTEGER,
  enableEndSession         INTEGER,
  subjectType              TEXT,
  scopes                   TEXT,
  userId                   TEXT REFERENCES users(id) ON DELETE CASCADE,
  createdAt                TEXT,
  updatedAt                TEXT,
  name                     TEXT,
  uri                      TEXT,
  icon                     TEXT,
  contacts                 TEXT,
  tos                      TEXT,
  policy                   TEXT,
  softwareId               TEXT,
  softwareVersion          TEXT,
  softwareStatement        TEXT,
  redirectUris             TEXT NOT NULL,
  postLogoutRedirectUris   TEXT,
  tokenEndpointAuthMethod  TEXT,
  grantTypes               TEXT,
  responseTypes            TEXT,
  public                   INTEGER,
  type                     TEXT,
  requirePKCE              INTEGER,
  referenceId              TEXT,
  metadata                 TEXT
);
CREATE INDEX oauthClient_userId ON oauthClient(userId);

CREATE TABLE oauthRefreshToken (
  id           TEXT PRIMARY KEY,
  token        TEXT NOT NULL UNIQUE,
  clientId     TEXT NOT NULL REFERENCES oauthClient(clientId) ON DELETE CASCADE,
  sessionId    TEXT REFERENCES sessions(id) ON DELETE SET NULL,
  userId       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  referenceId  TEXT,
  expiresAt    TEXT,
  createdAt    TEXT,
  revoked      TEXT,
  authTime     TEXT,
  scopes       TEXT NOT NULL
);
CREATE INDEX oauthRefreshToken_clientId ON oauthRefreshToken(clientId);
CREATE INDEX oauthRefreshToken_sessionId ON oauthRefreshToken(sessionId);
CREATE INDEX oauthRefreshToken_userId ON oauthRefreshToken(userId);

CREATE TABLE oauthAccessToken (
  id           TEXT PRIMARY KEY,
  token        TEXT UNIQUE,
  clientId     TEXT NOT NULL REFERENCES oauthClient(clientId) ON DELETE CASCADE,
  sessionId    TEXT REFERENCES sessions(id) ON DELETE SET NULL,
  userId       TEXT REFERENCES users(id) ON DELETE CASCADE,
  referenceId  TEXT,
  refreshId    TEXT REFERENCES oauthRefreshToken(id) ON DELETE SET NULL,
  expiresAt    TEXT,
  createdAt    TEXT,
  scopes       TEXT NOT NULL
);
CREATE INDEX oauthAccessToken_clientId ON oauthAccessToken(clientId);
CREATE INDEX oauthAccessToken_sessionId ON oauthAccessToken(sessionId);
CREATE INDEX oauthAccessToken_userId ON oauthAccessToken(userId);
CREATE INDEX oauthAccessToken_refreshId ON oauthAccessToken(refreshId);

CREATE TABLE oauthConsent (
  id           TEXT PRIMARY KEY,
  clientId     TEXT NOT NULL REFERENCES oauthClient(clientId) ON DELETE CASCADE,
  userId       TEXT REFERENCES users(id) ON DELETE CASCADE,
  referenceId  TEXT,
  scopes       TEXT NOT NULL,
  createdAt    TEXT,
  updatedAt    TEXT
);
CREATE INDEX oauthConsent_clientId ON oauthConsent(clientId);
CREATE INDEX oauthConsent_userId ON oauthConsent(userId);

CREATE TABLE mcp_artifact_posts (
  id            TEXT PRIMARY KEY,
  shareable_id  TEXT NOT NULL REFERENCES shareables(id) ON DELETE CASCADE,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  client_id     TEXT,
  action        TEXT NOT NULL CHECK (action IN ('publish', 'update')),
  content_hash  TEXT NOT NULL,
  created_at    TEXT NOT NULL
);
CREATE INDEX mcp_artifact_posts_idempotency
  ON mcp_artifact_posts(user_id, content_hash);
CREATE INDEX mcp_artifact_posts_workspace
  ON mcp_artifact_posts(workspace_id, user_id, created_at);
CREATE INDEX mcp_artifact_posts_shareable
  ON mcp_artifact_posts(shareable_id);

CREATE TABLE pending_signup_analytics (
  user_id           TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  method            TEXT NOT NULL CHECK (method IN ('google', 'microsoft', 'email')),
  workspace_created INTEGER NOT NULL CHECK (workspace_created IN (0, 1)),
  created_at        TEXT NOT NULL,
  claimed_at        TEXT,
  tracked_at        TEXT
);

CREATE TABLE first_post_analytics (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  channel TEXT,
  first_posted_at TEXT NOT NULL,
  CHECK (channel IS NULL OR channel IN ('web', 'cli', 'mcp'))
);

-- ────────────────────────────────────────────────
-- artifact_keys (CLI stable keys)
-- ────────────────────────────────────────────────
-- Stable-key index for CLI `publish --key`. One row maps
-- (owner, destination container, key) to the shareable it updates, so CI can
-- re-publish without storing artifact IDs. Rows cascade away with the
-- shareable; keys do not follow a shareable when it moves to another container.
CREATE TABLE artifact_keys (
  id             TEXT PRIMARY KEY,
  workspace_id   TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  owner_user_id  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  container_id   TEXT NOT NULL REFERENCES artifact_containers(id) ON DELETE CASCADE,
  stable_key     TEXT NOT NULL,
  shareable_id   TEXT NOT NULL REFERENCES shareables(id) ON DELETE CASCADE,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  UNIQUE (owner_user_id, container_id, stable_key)
);

-- Cascade cleanup and "which keys point here" lookups by shareable.
CREATE INDEX artifact_keys_shareable ON artifact_keys(shareable_id);

-- ────────────────────────────────────────────────
-- api_tokens (CI / non-interactive CLI auth)
-- ────────────────────────────────────────────────
-- Long-lived bearer tokens issued from the settings UI. Plaintext is shown once
-- at creation; only SHA-256 hex hashes are stored. Revocation is explicit only.
CREATE TABLE api_tokens (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  token_hash   TEXT NOT NULL UNIQUE,
  created_at   TEXT NOT NULL,
  last_used_at TEXT,
  revoked_at   TEXT
);
CREATE INDEX api_tokens_user_id ON api_tokens(user_id);

-- API tokens bypass the CLI authority resolver in the auth middleware, so the
-- database is the only guard that keeps bots off the unrestricted API-token
-- path.
CREATE TRIGGER api_tokens_reject_bot_insert
BEFORE INSERT ON api_tokens
WHEN EXISTS (SELECT 1 FROM users WHERE id = NEW.user_id AND kind = 'bot')
BEGIN
  SELECT RAISE(ABORT, 'api tokens are not available to bot users');
END;
CREATE TRIGGER api_tokens_reject_bot_update
BEFORE UPDATE ON api_tokens
WHEN EXISTS (SELECT 1 FROM users WHERE id = NEW.user_id AND kind = 'bot')
BEGIN
  SELECT RAISE(ABORT, 'api tokens are not available to bot users');
END;

-- ────────────────────────────────────────────────
-- audit_events (workspace audit log)
-- ────────────────────────────────────────────────
-- General audit log for workspace operations. actor_user_id is the only FK;
-- subject fields are stored as values so records survive subject removal.
CREATE TABLE audit_events (
  id             TEXT PRIMARY KEY,
  workspace_id   TEXT NOT NULL,
  actor_user_id  TEXT REFERENCES users(id) ON DELETE SET NULL,
  action         TEXT NOT NULL,
  subject_type   TEXT NOT NULL,
  subject_id     TEXT NOT NULL,
  detail         TEXT,
  created_at     TEXT NOT NULL
);
CREATE INDEX audit_events_workspace_created ON audit_events(workspace_id, created_at DESC);
CREATE INDEX audit_events_workspace_actor_action_created
  ON audit_events(workspace_id, actor_user_id, action, created_at DESC, id DESC);

-- Durable security attribution. Identifiers are values rather than foreign
-- keys so normal subject, actor, and workspace deletion cannot erase records.
CREATE TABLE security_audit_records (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  actor_type   TEXT NOT NULL,
  actor_id     TEXT NOT NULL,
  client_type  TEXT NOT NULL,
  client_id    TEXT,
  subject_type TEXT NOT NULL,
  subject_id   TEXT NOT NULL,
  action       TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  CHECK (client_type <> 'oauth_client' OR client_id IS NOT NULL)
);
CREATE INDEX security_audit_workspace_created ON security_audit_records(workspace_id, created_at DESC);
CREATE INDEX security_audit_subject_created ON security_audit_records(subject_type, subject_id, created_at DESC);
CREATE INDEX security_audit_actor_created ON security_audit_records(actor_type, actor_id, created_at DESC);
CREATE INDEX security_audit_client_created ON security_audit_records(client_type, client_id, created_at DESC);
CREATE INDEX security_audit_cleanup ON security_audit_records(created_at, id);

-- events (shared activity and view history)
CREATE TABLE events (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('artifact_created', 'version_published', 'comment_posted', 'artifact_viewed')),
  shareable_id TEXT NOT NULL REFERENCES shareables(id) ON DELETE CASCADE,
  actor_user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  subject_id TEXT,
  created_at TEXT NOT NULL,
  CHECK ((type = 'artifact_viewed') = (subject_id IS NULL)),
  CHECK (type = 'artifact_viewed' OR actor_user_id IS NOT NULL)
);
CREATE UNIQUE INDEX events_type_subject ON events(type, subject_id) WHERE subject_id IS NOT NULL;
CREATE INDEX events_workspace_created ON events(workspace_id, created_at DESC, id);
CREATE INDEX events_shareable_created ON events(shareable_id, created_at DESC);
CREATE INDEX events_type_created ON events(type, created_at);

CREATE TABLE project_pins (
  container_id      TEXT NOT NULL REFERENCES artifact_containers(id) ON DELETE CASCADE,
  shareable_id      TEXT NOT NULL REFERENCES shareables(id) ON DELETE CASCADE,
  pinned_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at        TEXT NOT NULL,
  PRIMARY KEY (container_id, shareable_id)
);
CREATE INDEX project_pins_shareable ON project_pins(shareable_id);

-- Scheduled workspace migration wait reconciliation lookups.
CREATE INDEX users_email_domain_kind_workspace
  ON users(lower(substr(email, instr(email, '@') + 1)), kind, workspace_id);
CREATE INDEX shareables_owner_user_id ON shareables(owner_user_id);
CREATE INDEX artifact_containers_owner_kind
  ON artifact_containers(owner_user_id, kind);
CREATE INDEX artifact_containers_created_by_kind
  ON artifact_containers(created_by_id, kind);
CREATE INDEX comment_threads_created_by_id ON comment_threads(created_by_id);
CREATE INDEX comment_messages_created_by_id ON comment_messages(created_by_id);
CREATE INDEX agent_profiles_workspace_id ON agent_profiles(workspace_id);
CREATE INDEX cli_family_authorities_workspace_id
  ON cli_family_authorities(workspace_id);
CREATE INDEX cli_session_authorities_workspace_id
  ON cli_session_authorities(workspace_id);
CREATE INDEX artifact_keys_workspace_id ON artifact_keys(workspace_id);
