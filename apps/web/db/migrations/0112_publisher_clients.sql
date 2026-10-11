-- Add stable publisher identities and device authority provenance.
CREATE TABLE publisher_clients (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 100 AND name = trim(name)),
  created_at TEXT NOT NULL,
  UNIQUE (user_id, workspace_id, name)
);
CREATE INDEX publisher_clients_workspace_id ON publisher_clients(workspace_id);

CREATE TABLE cli_family_authorities_tmp AS SELECT family_id, user_id, preset, workspace_id, project_id, project_name_snapshot, agent_profile_id, bridge_authority_id, approved_at, device_name, status, created_at, updated_at FROM cli_family_authorities;
CREATE TABLE cli_session_authorities_tmp AS SELECT session_id, family_id, kind, preset, workspace_id, project_id, agent_profile_id, expires_at, bearer_only, created_at FROM cli_session_authorities;
CREATE TABLE deviceCode_tmp AS SELECT id, deviceCode, userCode, userId, expiresAt, status, lastPolledAt, pollingInterval, clientId, scope, preset, deviceName, approvalNonce, selectedProjectId, requestedProjectSelector FROM deviceCode;
DROP TABLE cli_session_authorities;
DROP TABLE cli_family_authorities;
DROP TABLE deviceCode;
CREATE TABLE cli_family_authorities (
  family_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  preset TEXT NOT NULL CHECK (preset IN ('unrestricted', 'agent', 'publisher')),
  workspace_id TEXT REFERENCES workspaces(id) ON DELETE RESTRICT,
  project_id TEXT REFERENCES artifact_containers(id) ON DELETE RESTRICT,
  project_name_snapshot TEXT,
  publisher_client_id TEXT REFERENCES publisher_clients(id) ON DELETE RESTRICT,
  agent_profile_id TEXT REFERENCES agent_profiles(id) ON DELETE RESTRICT,
  bridge_authority_id TEXT REFERENCES bridge_authorities(id) ON DELETE RESTRICT,
  approved_at TEXT,
  device_name TEXT,
  status TEXT NOT NULL CHECK (status IN ('active', 'revoked', 'superseded')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  -- project_id may be NULL for agent presets: project deletion detaches
  -- non-live agent authorities from the project (project_name_snapshot stays).
  CHECK ((preset = 'publisher' AND workspace_id IS NOT NULL AND publisher_client_id IS NOT NULL AND project_id IS NULL AND agent_profile_id IS NULL AND bridge_authority_id IS NULL AND project_name_snapshot IS NULL) OR (preset <> 'publisher' AND publisher_client_id IS NULL)),
  CHECK ((preset = 'unrestricted' AND workspace_id IS NULL AND project_id IS NULL AND agent_profile_id IS NULL) OR (preset = 'agent' AND workspace_id IS NOT NULL AND agent_profile_id IS NOT NULL) OR preset = 'publisher')
);
INSERT INTO cli_family_authorities (family_id, user_id, preset, workspace_id, project_id, project_name_snapshot, agent_profile_id, bridge_authority_id, approved_at, device_name, status, created_at, updated_at) SELECT family_id, user_id, preset, workspace_id, project_id, project_name_snapshot, agent_profile_id, bridge_authority_id, approved_at, device_name, status, created_at, updated_at FROM cli_family_authorities_tmp;
CREATE INDEX cli_family_authorities_user_id ON cli_family_authorities(user_id);
CREATE INDEX cli_family_authorities_agent_profile_id ON cli_family_authorities(agent_profile_id);
CREATE INDEX cli_family_authorities_bridge_authority_id
  ON cli_family_authorities(bridge_authority_id);
CREATE INDEX cli_family_authorities_workspace_id
  ON cli_family_authorities(workspace_id);
CREATE TABLE cli_session_authorities (
  session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  family_id TEXT REFERENCES cli_family_authorities(family_id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('bootstrap', 'family')),
  preset TEXT NOT NULL CHECK (preset IN ('unrestricted', 'agent', 'publisher')),
  workspace_id TEXT REFERENCES workspaces(id) ON DELETE RESTRICT,
  project_id TEXT REFERENCES artifact_containers(id) ON DELETE RESTRICT,
  publisher_client_id TEXT REFERENCES publisher_clients(id) ON DELETE RESTRICT,
  agent_profile_id TEXT REFERENCES agent_profiles(id) ON DELETE RESTRICT,
  expires_at TEXT,
  bearer_only INTEGER NOT NULL DEFAULT 1 CHECK (bearer_only IN (0, 1)),
  created_at TEXT NOT NULL,
  CHECK ((preset = 'publisher' AND workspace_id IS NOT NULL AND publisher_client_id IS NOT NULL AND project_id IS NULL AND agent_profile_id IS NULL) OR (preset <> 'publisher' AND publisher_client_id IS NULL)),
  CHECK ((kind = 'bootstrap' AND family_id IS NULL AND expires_at IS NOT NULL) OR (kind = 'family' AND family_id IS NOT NULL AND expires_at IS NULL))
);
INSERT INTO cli_session_authorities (session_id, family_id, kind, preset, workspace_id, project_id, agent_profile_id, expires_at, bearer_only, created_at) SELECT session_id, family_id, kind, preset, workspace_id, project_id, agent_profile_id, expires_at, bearer_only, created_at FROM cli_session_authorities_tmp;
CREATE INDEX cli_session_authorities_family_id ON cli_session_authorities(family_id);
CREATE INDEX cli_session_authorities_workspace_id
  ON cli_session_authorities(workspace_id);
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
  preset           TEXT CHECK (preset IS NULL OR preset IN ('unrestricted', 'agent', 'publisher')),
  deviceName       TEXT,
  approvalNonce    TEXT,
  selectedProjectId TEXT,
  selectedPublisherClientId TEXT REFERENCES publisher_clients(id) ON DELETE RESTRICT,
  requestedProjectSelector TEXT CHECK (
    requestedProjectSelector IS NULL
    OR (
      requestedProjectSelector = trim(requestedProjectSelector)
      AND length(requestedProjectSelector) BETWEEN 1 AND 120
    )
  ),
  CHECK (preset IS 'publisher' OR selectedPublisherClientId IS NULL),
  CHECK (preset IS NOT 'publisher' OR (deviceName IS NOT NULL AND length(deviceName) BETWEEN 1 AND 100 AND selectedProjectId IS NULL AND requestedProjectSelector IS NULL))
);
INSERT INTO deviceCode (id, deviceCode, userCode, userId, expiresAt, status, lastPolledAt, pollingInterval, clientId, scope, preset, deviceName, approvalNonce, selectedProjectId, requestedProjectSelector) SELECT id, deviceCode, userCode, userId, expiresAt, status, lastPolledAt, pollingInterval, clientId, scope, preset, deviceName, approvalNonce, selectedProjectId, requestedProjectSelector FROM deviceCode_tmp;
CREATE INDEX deviceCode_userId ON deviceCode(userId);
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
CREATE TABLE _migration_0112_guard (ok INTEGER NOT NULL CHECK (ok = 1));
INSERT INTO _migration_0112_guard SELECT CASE WHEN (SELECT COUNT(*) FROM cli_family_authorities) = (SELECT COUNT(*) FROM cli_family_authorities_tmp) THEN 1 ELSE 0 END;
INSERT INTO _migration_0112_guard SELECT CASE WHEN (SELECT COUNT(*) FROM cli_session_authorities) = (SELECT COUNT(*) FROM cli_session_authorities_tmp) THEN 1 ELSE 0 END;
INSERT INTO _migration_0112_guard SELECT CASE WHEN (SELECT COUNT(*) FROM deviceCode) = (SELECT COUNT(*) FROM deviceCode_tmp) THEN 1 ELSE 0 END;
INSERT INTO _migration_0112_guard SELECT CASE WHEN NOT EXISTS (
  SELECT 1 FROM cli_session_authorities sa WHERE sa.family_id IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM cli_family_authorities fa WHERE fa.family_id = sa.family_id)
) THEN 1 ELSE 0 END;
DROP TABLE _migration_0112_guard;
DROP TABLE cli_family_authorities_tmp;
DROP TABLE cli_session_authorities_tmp;
DROP TABLE deviceCode_tmp;
ALTER TABLE shareables ADD COLUMN created_by_publisher_client_id TEXT REFERENCES publisher_clients(id) ON DELETE RESTRICT;
CREATE INDEX shareables_created_by_publisher_client_id ON shareables(created_by_publisher_client_id);
ALTER TABLE versions ADD COLUMN created_by_publisher_client_id TEXT REFERENCES publisher_clients(id) ON DELETE RESTRICT;
CREATE INDEX versions_created_by_publisher_client_id ON versions(created_by_publisher_client_id);
