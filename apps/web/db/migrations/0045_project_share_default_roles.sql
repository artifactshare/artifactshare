-- Migration: 0045_project_share_default_roles
-- Created: 2026-06-15
-- Description: Widen project_share_defaults.role CHECK to viewer, contributor, and
-- manager. SQLite cannot alter a CHECK constraint in place, so rebuild the table.

CREATE TABLE project_share_defaults_new (
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

INSERT INTO project_share_defaults_new (
  id, project_container_id, email, role, display_name, created_by_id, created_at, updated_at
)
SELECT
  id, project_container_id, email, role, display_name, created_by_id, created_at, updated_at
FROM project_share_defaults;

DROP TABLE project_share_defaults;

ALTER TABLE project_share_defaults_new RENAME TO project_share_defaults;

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
