-- Drop NULL allowance on shareables.drive_container_folder_id /
-- drive_versions_folder_id now that all legacy (Picker, v1-imported) rows
-- have been removed from production after the migration was verified.
-- SQLite cannot ALTER a column's nullability in
-- place, so the standard table-rebuild pattern is used.
--
-- Pre-flight check (manual, run before applying): no row should have
-- drive_container_folder_id IS NULL or drive_versions_folder_id IS NULL.
-- If any survive, the INSERT INTO shareables_new will fail the NOT NULL
-- constraint and roll back this migration.

PRAGMA foreign_keys = OFF;

CREATE TABLE shareables_new (
  id                         TEXT PRIMARY KEY,
  workspace_id               TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  owner_user_id              TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  slug                       TEXT,
  name                       TEXT NOT NULL,
  description                TEXT,
  container_type             TEXT NOT NULL,
  artifact_kind              TEXT NOT NULL,
  visibility                 TEXT NOT NULL,
  drive_container_folder_id  TEXT NOT NULL,
  drive_versions_folder_id   TEXT NOT NULL,
  drive_previews_folder_id   TEXT,
  current_version_id         TEXT,
  view_count                 INTEGER NOT NULL DEFAULT 0,
  created_at                 TEXT NOT NULL,
  updated_at                 TEXT NOT NULL,
  last_accessed_at           TEXT
);

INSERT INTO shareables_new (
  id, workspace_id, owner_user_id, slug, name, description,
  container_type, artifact_kind, visibility,
  drive_container_folder_id, drive_versions_folder_id, drive_previews_folder_id,
  current_version_id, view_count, created_at, updated_at, last_accessed_at
)
SELECT
  id, workspace_id, owner_user_id, slug, name, description,
  container_type, artifact_kind, visibility,
  drive_container_folder_id, drive_versions_folder_id, drive_previews_folder_id,
  current_version_id, view_count, created_at, updated_at, last_accessed_at
FROM shareables;

DROP TABLE shareables;
ALTER TABLE shareables_new RENAME TO shareables;

CREATE INDEX shareables_workspace_owner_created
  ON shareables(workspace_id, owner_user_id, created_at DESC);
CREATE UNIQUE INDEX shareables_workspace_slug
  ON shareables(workspace_id, slug) WHERE slug IS NOT NULL;

PRAGMA foreign_keys = ON;
