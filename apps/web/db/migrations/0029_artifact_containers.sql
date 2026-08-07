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
  CHECK (
    (kind = 'inbox' AND owner_user_id IS NOT NULL) OR
    (kind = 'project')
  )
);

CREATE INDEX artifact_containers_workspace_kind_updated
  ON artifact_containers(workspace_id, kind, archived_at, updated_at DESC);
CREATE UNIQUE INDEX artifact_containers_one_inbox_per_owner
  ON artifact_containers(workspace_id, owner_user_id)
  WHERE kind = 'inbox';

INSERT INTO artifact_containers (
  id,
  workspace_id,
  kind,
  owner_user_id,
  created_by_id,
  name,
  description,
  archived_at,
  created_at,
  updated_at
)
SELECT
  projects.id,
  projects.workspace_id,
  'project',
  NULL,
  projects.created_by_id,
  projects.name,
  projects.description,
  projects.archived_at,
  projects.created_at,
  projects.updated_at
FROM projects
WHERE projects.is_default = 0;

INSERT INTO artifact_containers (
  id,
  workspace_id,
  kind,
  owner_user_id,
  created_by_id,
  name,
  description,
  archived_at,
  created_at,
  updated_at
)
SELECT
  lower(hex(randomblob(16))),
  shareables.workspace_id,
  'inbox',
  shareables.owner_user_id,
  shareables.owner_user_id,
  '未整理',
  NULL,
  NULL,
  MIN(shareables.created_at),
  MIN(shareables.created_at)
FROM shareables
LEFT JOIN projects ON projects.id = shareables.project_id
WHERE shareables.project_id IS NULL OR projects.is_default = 1
GROUP BY shareables.workspace_id, shareables.owner_user_id;

ALTER TABLE shareables ADD COLUMN container_id TEXT REFERENCES artifact_containers(id) ON DELETE SET NULL;

UPDATE shareables
SET container_id = project_id
WHERE project_id IN (
  SELECT id
  FROM artifact_containers
  WHERE kind = 'project'
);

UPDATE shareables
SET container_id = (
  SELECT artifact_containers.id
  FROM artifact_containers
  WHERE artifact_containers.kind = 'inbox'
    AND artifact_containers.workspace_id = shareables.workspace_id
    AND artifact_containers.owner_user_id = shareables.owner_user_id
)
WHERE container_id IS NULL;

CREATE TABLE artifact_container_migration_assertions (
  must_be_empty TEXT NOT NULL
);

INSERT INTO artifact_container_migration_assertions (must_be_empty)
SELECT NULL
FROM shareables
WHERE container_id IS NULL
LIMIT 1;

DROP TABLE artifact_container_migration_assertions;

CREATE INDEX shareables_container_created
  ON shareables(container_id, created_at DESC);

CREATE TABLE project_share_defaults (
  id                    TEXT PRIMARY KEY,
  project_container_id  TEXT NOT NULL REFERENCES artifact_containers(id) ON DELETE CASCADE,
  email                 TEXT NOT NULL,
  role                  TEXT NOT NULL DEFAULT 'viewer' CHECK (role IN ('viewer')),
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

INSERT OR IGNORE INTO project_share_defaults (
  id,
  project_container_id,
  email,
  role,
  display_name,
  created_by_id,
  created_at,
  updated_at
)
SELECT
  project_grants.id,
  project_grants.project_id,
  lower(project_grants.email),
  project_grants.role,
  project_grants.display_name,
  project_grants.created_by_id,
  project_grants.created_at,
  project_grants.updated_at
FROM project_grants
INNER JOIN artifact_containers
  ON artifact_containers.id = project_grants.project_id
WHERE artifact_containers.kind = 'project'
ORDER BY lower(project_grants.email), project_grants.created_at, project_grants.id;

CREATE TABLE shareable_grant_origins_next (
  shareable_id                TEXT NOT NULL,
  granted_email               TEXT NOT NULL,
  origin_type                 TEXT NOT NULL CHECK (origin_type IN ('manual', 'project')),
  project_share_default_id    TEXT REFERENCES project_share_defaults(id) ON DELETE CASCADE,
  created_at                  TEXT NOT NULL,
  created_by                  TEXT REFERENCES users(id) ON DELETE SET NULL,
  FOREIGN KEY (shareable_id, granted_email)
    REFERENCES shareable_grants(shareable_id, granted_email)
    ON DELETE CASCADE,
  CHECK (
    (origin_type = 'manual' AND project_share_default_id IS NULL) OR
    (origin_type = 'project' AND project_share_default_id IS NOT NULL)
  )
);

INSERT INTO shareable_grant_origins_next (
  shareable_id,
  granted_email,
  origin_type,
  project_share_default_id,
  created_at,
  created_by
)
SELECT
  shareable_id,
  granted_email,
  origin_type,
  CASE
    WHEN origin_type = 'project'
      AND project_grant_id IN (SELECT id FROM project_share_defaults)
    THEN project_grant_id
    ELSE NULL
  END,
  created_at,
  created_by
FROM shareable_grant_origins
WHERE origin_type = 'manual'
   OR project_grant_id IN (SELECT id FROM project_share_defaults);

DROP TABLE shareable_grant_origins;
ALTER TABLE shareable_grant_origins_next RENAME TO shareable_grant_origins;

CREATE UNIQUE INDEX shareable_grant_origins_manual_unique
  ON shareable_grant_origins(shareable_id, granted_email)
  WHERE origin_type = 'manual';

CREATE UNIQUE INDEX shareable_grant_origins_project_unique
  ON shareable_grant_origins(shareable_id, granted_email, project_share_default_id)
  WHERE origin_type = 'project';

CREATE INDEX shareable_grant_origins_project_share_default
  ON shareable_grant_origins(project_share_default_id);

CREATE TABLE shareable_project_share_default_exclusions (
  shareable_id                TEXT NOT NULL REFERENCES shareables(id) ON DELETE CASCADE,
  project_share_default_id    TEXT NOT NULL REFERENCES project_share_defaults(id) ON DELETE CASCADE,
  created_by_id              TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at                 TEXT NOT NULL,
  PRIMARY KEY (shareable_id, project_share_default_id)
);

INSERT INTO shareable_project_share_default_exclusions (
  shareable_id,
  project_share_default_id,
  created_by_id,
  created_at
)
SELECT
  shareable_id,
  project_grant_id,
  created_by_id,
  created_at
FROM shareable_project_grant_exclusions
WHERE project_grant_id IN (SELECT id FROM project_share_defaults);

CREATE INDEX shareable_project_share_default_exclusions_project_share_default
  ON shareable_project_share_default_exclusions(project_share_default_id);

DROP TABLE shareable_project_grant_exclusions;
