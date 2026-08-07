PRAGMA foreign_keys = OFF;

CREATE TABLE shareables_new (
  id                         TEXT PRIMARY KEY,
  workspace_id               TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  owner_user_id              TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  slug                       TEXT,
  name                       TEXT NOT NULL,
  derived_title              TEXT,
  title_override             TEXT,
  description                TEXT,
  container_type             TEXT NOT NULL,
  artifact_kind              TEXT NOT NULL,
  visibility                 TEXT NOT NULL,
  drive_container_folder_id  TEXT NOT NULL,
  drive_previews_folder_id   TEXT,
  current_version_id         TEXT,
  view_count                 INTEGER NOT NULL DEFAULT 0,
  created_at                 TEXT NOT NULL,
  updated_at                 TEXT NOT NULL,
  last_accessed_at           TEXT
);

INSERT INTO shareables_new (
  id, workspace_id, owner_user_id, slug, name, derived_title, title_override,
  description, container_type, artifact_kind, visibility,
  drive_container_folder_id, drive_previews_folder_id, current_version_id,
  view_count, created_at, updated_at, last_accessed_at
)
SELECT
  id, workspace_id, owner_user_id, slug, name, derived_title, title_override,
  description, container_type, artifact_kind, visibility,
  drive_container_folder_id, drive_previews_folder_id, current_version_id,
  view_count, created_at, updated_at, last_accessed_at
FROM shareables;

DROP TABLE shareables;
ALTER TABLE shareables_new RENAME TO shareables;

CREATE INDEX shareables_workspace_owner_created
  ON shareables(workspace_id, owner_user_id, created_at DESC);
CREATE UNIQUE INDEX shareables_workspace_slug
  ON shareables(workspace_id, slug) WHERE slug IS NOT NULL;

CREATE TABLE versions_new (
  id                        TEXT PRIMARY KEY,
  shareable_id              TEXT NOT NULL REFERENCES shareables(id) ON DELETE CASCADE,
  artifact_kind             TEXT NOT NULL,
  status                    TEXT NOT NULL,
  entrypoint_path           TEXT NOT NULL,
  drive_folder_id           TEXT NOT NULL,
  drive_entrypoint_file_id  TEXT NOT NULL,
  fallback_to_index         INTEGER NOT NULL DEFAULT 0,
  created_by_id             TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at                TEXT NOT NULL,
  published_at              TEXT
);

INSERT INTO versions_new (
  id, shareable_id, artifact_kind, status, entrypoint_path, drive_folder_id,
  drive_entrypoint_file_id, fallback_to_index, created_by_id, created_at,
  published_at
)
SELECT
  id, shareable_id, artifact_kind, status, entrypoint_path, drive_folder_id,
  drive_entrypoint_file_id, fallback_to_index, created_by_id, created_at,
  published_at
FROM versions;

DROP TABLE versions;
ALTER TABLE versions_new RENAME TO versions;

CREATE INDEX versions_shareable_id ON versions(shareable_id);
CREATE INDEX versions_drive_entrypoint_file_id ON versions(drive_entrypoint_file_id);

PRAGMA foreign_keys = ON;
