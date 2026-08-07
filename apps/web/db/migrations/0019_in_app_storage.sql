-- Pre-flight guard. 0019 wipes the schema to rebuild it for R2-backed storage,
-- so re-running it against a DB that still has rows would destroy production
-- data (e.g. after a snapshot restore that also rewound the migration ledger).
-- The CHECK fails the INSERT and aborts the migration transaction when users
-- already contains rows. Empty users (fresh DB, pre-0019 first apply) passes.
-- Non-TEMP table on purpose: Cloudflare D1 (production and miniflare alike)
-- rejects CREATE TEMP TABLE with SQLITE_AUTH.
CREATE TABLE _migration_0019_guard (ok INTEGER NOT NULL CHECK (ok = 1));
INSERT INTO _migration_0019_guard (ok)
  SELECT CASE WHEN (SELECT COUNT(*) FROM users) = 0 THEN 1 ELSE 0 END;
DROP TABLE _migration_0019_guard;

PRAGMA foreign_keys = OFF;

DROP TABLE IF EXISTS views;
DROP TABLE IF EXISTS views_anon;
DROP TABLE IF EXISTS sandbox_token_uses;
DROP TABLE IF EXISTS slack_user_links;
DROP TABLE IF EXISTS slack_workspaces;
DROP TABLE IF EXISTS shareable_grants;
DROP TABLE IF EXISTS version_files;
DROP TABLE IF EXISTS versions;
DROP TABLE IF EXISTS shareables;
DROP TABLE IF EXISTS verifications;
DROP TABLE IF EXISTS sessions;
DROP TABLE IF EXISTS accounts;
DROP TABLE IF EXISTS users;
DROP TABLE IF EXISTS workspaces;

CREATE TABLE workspaces (
  id          TEXT PRIMARY KEY,
  hd          TEXT UNIQUE,
  name        TEXT NOT NULL,
  created_at  TEXT NOT NULL
);

CREATE TABLE users (
  id                    TEXT PRIMARY KEY,
  email                 TEXT NOT NULL UNIQUE,
  email_verified        INTEGER NOT NULL DEFAULT 0,
  name                  TEXT,
  image                 TEXT,
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL,
  workspace_id          TEXT NOT NULL REFERENCES workspaces(id),
  google_sub            TEXT NOT NULL UNIQUE,
  locale                TEXT,
  plan                  TEXT NOT NULL DEFAULT 'free',
  storage_quota_bytes   INTEGER NOT NULL DEFAULT 104857600,
  storage_used_bytes    INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE accounts (
  id                        TEXT PRIMARY KEY,
  user_id                   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider_id               TEXT NOT NULL,
  account_id                TEXT NOT NULL,
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

CREATE TABLE verifications (
  id          TEXT PRIMARY KEY,
  identifier  TEXT NOT NULL,
  value       TEXT NOT NULL,
  expires_at  TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE TABLE shareables (
  id                  TEXT PRIMARY KEY,
  workspace_id        TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  owner_user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  slug                TEXT,
  name                TEXT NOT NULL,
  derived_title       TEXT,
  title_override      TEXT,
  description         TEXT,
  container_type      TEXT NOT NULL,
  artifact_kind       TEXT NOT NULL,
  visibility          TEXT NOT NULL,
  current_version_id  TEXT,
  view_count          INTEGER NOT NULL DEFAULT 0,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL,
  last_accessed_at    TEXT
);

CREATE TABLE shareable_grants (
  shareable_id  TEXT NOT NULL REFERENCES shareables(id) ON DELETE CASCADE,
  granted_email TEXT NOT NULL,
  granted_at    TEXT NOT NULL,
  granted_by    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (shareable_id, granted_email)
);

CREATE TABLE versions (
  id                TEXT PRIMARY KEY,
  shareable_id      TEXT NOT NULL REFERENCES shareables(id) ON DELETE CASCADE,
  artifact_kind     TEXT NOT NULL,
  status            TEXT NOT NULL,
  entrypoint_path   TEXT NOT NULL,
  r2_key            TEXT NOT NULL,
  size_bytes        INTEGER NOT NULL,
  sha256            TEXT NOT NULL,
  fallback_to_index INTEGER NOT NULL DEFAULT 0,
  created_by_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at        TEXT NOT NULL,
  published_at      TEXT
);

CREATE TABLE views (
  id              TEXT PRIMARY KEY,
  shareable_id    TEXT NOT NULL REFERENCES shareables(id) ON DELETE CASCADE,
  viewer_user_id  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  viewed_at       TEXT NOT NULL,
  user_agent_hash TEXT
);

CREATE TABLE views_anon (
  id              TEXT PRIMARY KEY,
  shareable_id    TEXT NOT NULL REFERENCES shareables(id) ON DELETE CASCADE,
  viewer_ip_hash  TEXT NOT NULL,
  viewed_at       TEXT NOT NULL,
  user_agent_hash TEXT
);

CREATE TABLE sandbox_token_uses (
  jti         TEXT PRIMARY KEY,
  expires_at  TEXT NOT NULL
);

CREATE TABLE slack_workspaces (
  id                    TEXT PRIMARY KEY,
  team_id               TEXT NOT NULL UNIQUE,
  team_name             TEXT NOT NULL,
  bot_user_id           TEXT NOT NULL,
  bot_token             TEXT NOT NULL,
  installed_by_user_id  TEXT REFERENCES users(id) ON DELETE SET NULL,
  installed_at          TEXT NOT NULL
);

CREATE TABLE slack_user_links (
  id                    TEXT PRIMARY KEY,
  slack_team_id         TEXT NOT NULL REFERENCES slack_workspaces(team_id) ON DELETE CASCADE,
  slack_user_id         TEXT NOT NULL,
  artifactshare_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  linked_at             TEXT NOT NULL,
  UNIQUE (slack_team_id, slack_user_id)
);

CREATE INDEX users_workspace_id ON users(workspace_id);
CREATE INDEX accounts_user_id ON accounts(user_id);
CREATE INDEX sessions_user_id ON sessions(user_id);
CREATE INDEX verifications_identifier ON verifications(identifier);
CREATE INDEX shareables_workspace_owner_created
  ON shareables(workspace_id, owner_user_id, created_at DESC);
CREATE UNIQUE INDEX shareables_workspace_slug
  ON shareables(workspace_id, slug) WHERE slug IS NOT NULL;
CREATE INDEX idx_shareable_grants_email ON shareable_grants(granted_email);
CREATE INDEX versions_shareable_id ON versions(shareable_id);
CREATE INDEX versions_r2_key ON versions(r2_key);
CREATE INDEX views_shareable_viewer_time
  ON views(shareable_id, viewer_user_id, viewed_at DESC);
CREATE INDEX views_viewer_time
  ON views(viewer_user_id, viewed_at DESC);
CREATE INDEX views_anon_shareable_ip_time
  ON views_anon(shareable_id, viewer_ip_hash, viewed_at DESC);
CREATE INDEX sandbox_token_uses_expires_at ON sandbox_token_uses(expires_at);
CREATE INDEX slack_user_links_artifactshare_user_id
  ON slack_user_links(artifactshare_user_id);

PRAGMA foreign_keys = ON;

SELECT
  (SELECT COUNT(*) FROM users) AS users_count,
  (SELECT COUNT(*) FROM shareables) AS shareables_count,
  (SELECT COUNT(*) FROM versions) AS versions_count;
