CREATE TABLE bridge_authorities (
  id                       TEXT PRIMARY KEY,
  workspace_id             TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  bot_user_id              TEXT NOT NULL UNIQUE REFERENCES users(id) ON DELETE RESTRICT,
  agent_profile_id         TEXT NOT NULL UNIQUE REFERENCES agent_profiles(id) ON DELETE RESTRICT,
  source_kind              TEXT NOT NULL,
  source_installation_id   TEXT NOT NULL,
  external_workspace_id    TEXT NOT NULL,
  fallback_project_id      TEXT NOT NULL REFERENCES artifact_containers(id) ON DELETE RESTRICT,
  created_at               TEXT NOT NULL,
  updated_at               TEXT NOT NULL,
  UNIQUE (workspace_id, source_kind, source_installation_id, external_workspace_id),
  CHECK (source_kind = trim(source_kind) AND length(source_kind) BETWEEN 1 AND 80),
  CHECK (source_installation_id = trim(source_installation_id) AND length(source_installation_id) BETWEEN 1 AND 200),
  CHECK (external_workspace_id = trim(external_workspace_id) AND length(external_workspace_id) BETWEEN 1 AND 200)
);
CREATE INDEX bridge_authorities_fallback_project_id
  ON bridge_authorities(fallback_project_id);

ALTER TABLE cli_family_authorities
  ADD COLUMN bridge_authority_id TEXT REFERENCES bridge_authorities(id) ON DELETE RESTRICT;
CREATE INDEX cli_family_authorities_bridge_authority_id
  ON cli_family_authorities(bridge_authority_id);

CREATE TABLE bridge_conversations (
  id                    TEXT PRIMARY KEY,
  bridge_authority_id   TEXT NOT NULL REFERENCES bridge_authorities(id) ON DELETE RESTRICT,
  project_id            TEXT NOT NULL UNIQUE REFERENCES artifact_containers(id) ON DELETE CASCADE,
  conversation_kind     TEXT NOT NULL CHECK (conversation_kind IN ('public_channel', 'private_channel')),
  conversation_name     TEXT,
  privacy_ceiling       TEXT NOT NULL CHECK (privacy_ceiling IN ('workspace', 'private')),
  privacy_epoch         INTEGER NOT NULL DEFAULT 0 CHECK (privacy_epoch IN (0, 1)),
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL,
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
  mapping_id                TEXT REFERENCES bridge_conversations(id) ON DELETE RESTRICT,
  requester_stable_id       TEXT NOT NULL,
  requester_verified_email  TEXT NOT NULL,
  stable_digest             TEXT,
  status                    TEXT NOT NULL CHECK (status IN ('binding', 'leased', 'completed')),
  lease_generation          TEXT,
  lease_expires_at          TEXT,
  result_artifact_id        TEXT REFERENCES shareables(id) ON DELETE RESTRICT,
  result_version_id         TEXT REFERENCES versions(id) ON DELETE RESTRICT,
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
    AND granted_email = NEW.requester_verified_email
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
