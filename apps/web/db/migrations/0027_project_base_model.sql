CREATE TABLE projects (
  id              TEXT PRIMARY KEY,
  workspace_id    TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  created_by_id   TEXT REFERENCES users(id) ON DELETE SET NULL,
  name            TEXT NOT NULL,
  description     TEXT,
  is_default      INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0, 1)),
  archived_at     TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
CREATE INDEX projects_workspace_archived_updated
  ON projects(workspace_id, archived_at, updated_at DESC);
CREATE UNIQUE INDEX projects_one_default_per_workspace
  ON projects(workspace_id) WHERE is_default = 1;

ALTER TABLE shareables ADD COLUMN project_id TEXT REFERENCES projects(id) ON DELETE SET NULL;
CREATE INDEX shareables_project_created
  ON shareables(project_id, created_at DESC);

INSERT OR IGNORE INTO projects (
  id,
  workspace_id,
  created_by_id,
  name,
  description,
  is_default,
  archived_at,
  created_at,
  updated_at
)
SELECT
  'default_' || workspaces.id,
  workspaces.id,
  NULL,
  'すべての成果物',
  NULL,
  1,
  NULL,
  workspaces.created_at,
  workspaces.created_at
FROM workspaces;

UPDATE shareables
SET project_id = 'default_' || workspace_id
WHERE project_id IS NULL;
