ALTER TABLE artifact_containers ADD COLUMN slug TEXT;

-- Backfill existing projects with a stable, valid, unique fallback slug.
-- These projects predate the /projects/:slug URL, so the documented fallback
-- (project-<identifier>) is used rather than re-deriving from the name in SQL.
UPDATE artifact_containers
SET slug = 'project-' || lower(hex(randomblob(4)))
WHERE kind = 'project' AND slug IS NULL;

-- Project URL is unique per workspace. Inboxes (slug NULL) are excluded.
CREATE UNIQUE INDEX artifact_containers_workspace_slug
  ON artifact_containers(workspace_id, slug)
  WHERE slug IS NOT NULL;
