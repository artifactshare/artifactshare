-- Migration: 0082_relax_agent_authority_project_check
-- Created: 2026-08-13
-- Description: Allow cli_family_authorities.project_id to be NULL for agent
-- presets. project_id REFERENCES artifact_containers ON DELETE RESTRICT, so a
-- project targeted by an agent credential could never be deleted — even after
-- the credential expired or was revoked. Project deletion now detaches the
-- project from non-live agent authorities by setting project_id to NULL, which
-- the old composite CHECK forbade. SQLite cannot alter a CHECK constraint in
-- place, so the table is rebuilt.
--
-- D1 ignores `PRAGMA foreign_keys = OFF`, and `PRAGMA defer_foreign_keys`
-- still fires cascade actions, so dropping cli_family_authorities while
-- cli_session_authorities rows still reference it (family_id ON DELETE
-- CASCADE) would silently delete every child row. The rebuild therefore runs
-- in dependency order with foreign keys fully enforced: copy both tables to
-- FK-free temp tables, drop the child first, then the parent, recreate both,
-- and reinsert from the copies. Guards abort the migration if either table's
-- row count changed or a child row lost its family linkage.

CREATE TABLE cli_family_authorities_tmp (
  family_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  preset TEXT NOT NULL,
  workspace_id TEXT,
  project_id TEXT,
  project_name_snapshot TEXT,
  agent_profile_id TEXT,
  approved_at TEXT,
  device_name TEXT,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
INSERT INTO cli_family_authorities_tmp (
  family_id, user_id, preset, workspace_id, project_id,
  project_name_snapshot, agent_profile_id, approved_at, device_name,
  status, created_at, updated_at
)
SELECT
  family_id, user_id, preset, workspace_id, project_id,
  project_name_snapshot, agent_profile_id, approved_at, device_name,
  status, created_at, updated_at
FROM cli_family_authorities;

CREATE TABLE cli_session_authorities_tmp (
  session_id TEXT PRIMARY KEY,
  family_id TEXT,
  kind TEXT NOT NULL,
  preset TEXT NOT NULL,
  workspace_id TEXT,
  project_id TEXT,
  agent_profile_id TEXT,
  expires_at TEXT,
  bearer_only INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
INSERT INTO cli_session_authorities_tmp (
  session_id, family_id, kind, preset, workspace_id, project_id,
  agent_profile_id, expires_at, bearer_only, created_at
)
SELECT
  session_id, family_id, kind, preset, workspace_id, project_id,
  agent_profile_id, expires_at, bearer_only, created_at
FROM cli_session_authorities;

-- Child first: dropping it triggers no cascade. Only then is the parent free
-- of referencing rows and safe to drop.
DROP TABLE cli_session_authorities;
DROP TABLE cli_family_authorities;

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
    (preset = 'agent' AND workspace_id IS NOT NULL AND agent_profile_id IS NOT NULL)
  )
);
INSERT INTO cli_family_authorities (
  family_id, user_id, preset, workspace_id, project_id,
  project_name_snapshot, agent_profile_id, approved_at, device_name,
  status, created_at, updated_at
)
SELECT
  family_id, user_id, preset, workspace_id, project_id,
  project_name_snapshot, agent_profile_id, approved_at, device_name,
  status, created_at, updated_at
FROM cli_family_authorities_tmp;
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
INSERT INTO cli_session_authorities (
  session_id, family_id, kind, preset, workspace_id, project_id,
  agent_profile_id, expires_at, bearer_only, created_at
)
SELECT
  session_id, family_id, kind, preset, workspace_id, project_id,
  agent_profile_id, expires_at, bearer_only, created_at
FROM cli_session_authorities_tmp;
CREATE INDEX cli_session_authorities_family_id ON cli_session_authorities(family_id);

-- Post-rebuild guards: both tables must keep their exact row counts, and every
-- family-kind session authority must still link to a surviving family row. A
-- violation inserts 0 into a CHECK (ok = 1) column and aborts the migration.
CREATE TABLE _migration_0082_guard (ok INTEGER NOT NULL CHECK (ok = 1));
INSERT INTO _migration_0082_guard (ok)
SELECT CASE
  WHEN (SELECT COUNT(*) FROM cli_family_authorities)
       = (SELECT COUNT(*) FROM cli_family_authorities_tmp)
  THEN 1 ELSE 0 END;
INSERT INTO _migration_0082_guard (ok)
SELECT CASE
  WHEN (SELECT COUNT(*) FROM cli_session_authorities)
       = (SELECT COUNT(*) FROM cli_session_authorities_tmp)
  THEN 1 ELSE 0 END;
INSERT INTO _migration_0082_guard (ok)
SELECT CASE
  WHEN (
    SELECT COUNT(*)
    FROM cli_session_authorities sa
    WHERE sa.family_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM cli_family_authorities fa
        WHERE fa.family_id = sa.family_id
      )
  ) = 0 THEN 1 ELSE 0 END;
DROP TABLE _migration_0082_guard;

DROP TABLE cli_family_authorities_tmp;
DROP TABLE cli_session_authorities_tmp;
