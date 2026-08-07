-- Backfill v1 artifacts → v2 shareables / versions / version_files.
-- 1 artifacts row maps to 1 shareables + 1 versions + 1 version_files row.
-- shareables.id preserves artifacts.id (share URL stability).
-- versions.id / version_files.id are migration-generated internal IDs
-- (hex 16 chars from randomblob(8)) — opaque, not URL-exposed.

-- shareables ↔ versions have circular FK (shareables.current_version_id →
-- versions.id; versions.shareable_id → shareables.id). Insert shareables
-- with current_version_id = NULL, then versions, then UPDATE the pointer.

-- 1. shareables (current_version_id left NULL for now).
INSERT INTO shareables (
  id,
  workspace_id,
  owner_user_id,
  slug,
  name,
  description,
  container_type,
  artifact_kind,
  visibility,
  drive_container_folder_id,
  drive_versions_folder_id,
  drive_previews_folder_id,
  current_version_id,
  view_count,
  created_at,
  updated_at,
  last_accessed_at
)
SELECT
  a.id,
  a.workspace_id,
  a.registered_by_id,
  NULL,
  a.drive_file_name,
  NULL,
  'quick_share',
  CASE
    WHEN lower(a.drive_mime_type) LIKE 'text/markdown%'
      OR lower(a.drive_file_name) LIKE '%.md'
      OR lower(a.drive_file_name) LIKE '%.markdown'
      THEN 'markdown_page'
    WHEN lower(a.drive_mime_type) LIKE 'text/html%'
      OR lower(a.drive_file_name) LIKE '%.html'
      OR lower(a.drive_file_name) LIKE '%.htm'
      THEN 'html_page'
    -- 0006 fails (NOT NULL violation) if any artifact resists detection —
    -- current registerArtifact rejects unknown mimes so this branch should
    -- never fire. The failure surfaces immediately rather than producing
    -- silently-broken rows.
  END,
  'private',
  NULL,
  NULL,
  NULL,
  NULL,
  a.view_count,
  a.created_at,
  a.created_at,
  a.last_accessed_at
FROM artifacts a;

-- 2. versions (shareable_id now resolves; id is migration-generated).
INSERT INTO versions (
  id,
  shareable_id,
  artifact_kind,
  status,
  entrypoint_path,
  drive_folder_id,
  drive_entrypoint_file_id,
  fallback_to_index,
  created_by_id,
  created_at,
  published_at
)
SELECT
  lower(hex(randomblob(8))),
  s.id,
  s.artifact_kind,
  'published',
  '/' || s.name,
  NULL,
  a.drive_file_id,
  0,
  a.registered_by_id,
  a.created_at,
  a.created_at
FROM shareables s
JOIN artifacts a ON a.id = s.id;

-- 3. version_files (one per version, mirrors the entrypoint file).
INSERT INTO version_files (
  id,
  version_id,
  path,
  drive_file_id,
  mime_type,
  size_bytes,
  sha256,
  created_at
)
SELECT
  lower(hex(randomblob(8))),
  v.id,
  v.entrypoint_path,
  v.drive_entrypoint_file_id,
  a.drive_mime_type,
  NULL,
  NULL,
  a.created_at
FROM versions v
JOIN artifacts a ON a.id = v.shareable_id;

-- 4. close the circular reference now that all sides exist.
UPDATE shareables
SET current_version_id = (
  SELECT v.id FROM versions v WHERE v.shareable_id = shareables.id
)
WHERE current_version_id IS NULL;
