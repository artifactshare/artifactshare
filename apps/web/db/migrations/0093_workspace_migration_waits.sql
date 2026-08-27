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

CREATE INDEX users_email_domain_kind_workspace
  ON users(lower(substr(email, instr(email, '@') + 1)), kind, workspace_id);
CREATE INDEX shareables_owner_user_id
  ON shareables(owner_user_id);
CREATE INDEX artifact_containers_owner_kind
  ON artifact_containers(owner_user_id, kind);
CREATE INDEX artifact_containers_created_by_kind
  ON artifact_containers(created_by_id, kind);
CREATE INDEX comment_threads_created_by_id
  ON comment_threads(created_by_id);
CREATE INDEX comment_messages_created_by_id
  ON comment_messages(created_by_id);
CREATE INDEX agent_profiles_workspace_id
  ON agent_profiles(workspace_id);
CREATE INDEX cli_family_authorities_workspace_id
  ON cli_family_authorities(workspace_id);
CREATE INDEX cli_session_authorities_workspace_id
  ON cli_session_authorities(workspace_id);
CREATE INDEX artifact_keys_workspace_id
  ON artifact_keys(workspace_id);
