-- shareables: URL slug + container metadata. id is the public short ID
-- (preserved from artifacts.id so /a/<shortId> stays stable).
-- folder columns + slug are NULLABLE for v1-imported (Picker) rows;
-- upload-first rows fill them.
CREATE TABLE shareables (
  id                         TEXT PRIMARY KEY,
  workspace_id               TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  owner_user_id              TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  slug                       TEXT,
  name                       TEXT NOT NULL,
  description                TEXT,
  container_type             TEXT NOT NULL,
  artifact_kind              TEXT NOT NULL,
  visibility                 TEXT NOT NULL,
  drive_container_folder_id  TEXT,
  drive_versions_folder_id   TEXT,
  drive_previews_folder_id   TEXT,
  current_version_id         TEXT,
  view_count                 INTEGER NOT NULL DEFAULT 0,
  created_at                 TEXT NOT NULL,
  updated_at                 TEXT NOT NULL,
  last_accessed_at           TEXT
);
CREATE INDEX shareables_workspace_owner_created
  ON shareables(workspace_id, owner_user_id, created_at DESC);
CREATE UNIQUE INDEX shareables_workspace_slug
  ON shareables(workspace_id, slug) WHERE slug IS NOT NULL;

-- versions: one row per upload / update. shareables.current_version_id
-- points here. drive_folder_id NULLABLE for v1-imported rows.
CREATE TABLE versions (
  id                        TEXT PRIMARY KEY,
  shareable_id              TEXT NOT NULL REFERENCES shareables(id) ON DELETE CASCADE,
  artifact_kind             TEXT NOT NULL,
  status                    TEXT NOT NULL,
  entrypoint_path           TEXT NOT NULL,
  drive_folder_id           TEXT,
  drive_entrypoint_file_id  TEXT NOT NULL,
  fallback_to_index         INTEGER NOT NULL DEFAULT 0,
  created_by_id             TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at                TEXT NOT NULL,
  published_at              TEXT
);
CREATE INDEX versions_shareable_id ON versions(shareable_id);
-- Speeds up the register-time de-dup query: shareables JOIN versions on
-- current_version_id, filtered by workspace + drive_entrypoint_file_id.
-- See findShareableByEntrypointFileId in app/services/shareables.server.ts.
CREATE INDEX versions_drive_entrypoint_file_id ON versions(drive_entrypoint_file_id);

-- version_files: path → drive_file_id resolver. MVP single-file means
-- 1 entry per version; Phase 2 multi-file expands. size_bytes / sha256
-- are NULLABLE for v1-imported rows (Drive API value not preserved).
CREATE TABLE version_files (
  id             TEXT PRIMARY KEY,
  version_id     TEXT NOT NULL REFERENCES versions(id) ON DELETE CASCADE,
  path           TEXT NOT NULL,
  drive_file_id  TEXT NOT NULL,
  mime_type      TEXT,
  size_bytes     INTEGER,
  sha256         TEXT,
  created_at     TEXT NOT NULL,
  UNIQUE (version_id, path)
);
CREATE INDEX version_files_drive_file_id ON version_files(drive_file_id);
