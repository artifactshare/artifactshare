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
  approved_at TEXT,
  device_name TEXT,
  status TEXT NOT NULL CHECK (status IN ('active', 'revoked', 'superseded')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (
    (preset = 'unrestricted' AND workspace_id IS NULL AND project_id IS NULL AND agent_profile_id IS NULL)
    OR
    (preset = 'agent' AND workspace_id IS NOT NULL AND project_id IS NOT NULL AND agent_profile_id IS NOT NULL)
  )
);
CREATE INDEX cli_family_authorities_user_id ON cli_family_authorities(user_id);
CREATE INDEX cli_family_authorities_agent_profile_id ON cli_family_authorities(agent_profile_id);

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
  CHECK (
    (kind = 'bootstrap' AND family_id IS NULL AND expires_at IS NOT NULL)
    OR
    (kind = 'family' AND family_id IS NOT NULL AND expires_at IS NULL)
  )
);
CREATE INDEX cli_session_authorities_family_id ON cli_session_authorities(family_id);

ALTER TABLE deviceCode ADD COLUMN preset TEXT CHECK (preset IS NULL OR preset IN ('unrestricted', 'agent'));
ALTER TABLE deviceCode ADD COLUMN deviceName TEXT;
ALTER TABLE deviceCode ADD COLUMN approvalNonce TEXT;
ALTER TABLE deviceCode ADD COLUMN selectedProjectId TEXT;

ALTER TABLE shareables ADD COLUMN created_by_agent_profile_id TEXT REFERENCES agent_profiles(id) ON DELETE RESTRICT;
CREATE INDEX shareables_created_by_agent_profile_id ON shareables(created_by_agent_profile_id);

ALTER TABLE comment_messages ADD COLUMN created_by_agent_profile_id TEXT REFERENCES agent_profiles(id) ON DELETE RESTRICT;
CREATE INDEX comment_messages_created_by_agent_profile_id ON comment_messages(created_by_agent_profile_id);
