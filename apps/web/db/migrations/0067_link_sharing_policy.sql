-- Add link-sharing policy columns without rebuilding the workspaces/shareables tables.
-- The default-days column must exist before max-days so the cross-column CHECK can
-- reference it on the second ALTER TABLE.

ALTER TABLE workspaces
ADD COLUMN link_sharing_enabled INTEGER NOT NULL DEFAULT 0
  CHECK (link_sharing_enabled IN (0, 1));

ALTER TABLE workspaces
ADD COLUMN external_posting_enabled INTEGER NOT NULL DEFAULT 0
  CHECK (external_posting_enabled IN (0, 1));

ALTER TABLE workspaces
ADD COLUMN link_expiry_default_days INTEGER DEFAULT 30
  CHECK (
    link_expiry_default_days IS NULL
    OR (link_expiry_default_days BETWEEN 1 AND 365)
  );

ALTER TABLE workspaces
ADD COLUMN link_expiry_max_days INTEGER DEFAULT 90
  CHECK (
    link_expiry_max_days IS NULL
    OR (
      link_expiry_max_days BETWEEN 1 AND 365
      AND link_expiry_default_days IS NOT NULL
      AND link_expiry_default_days <= link_expiry_max_days
    )
  );

ALTER TABLE shareables
ADD COLUMN link_expires_at TEXT;

UPDATE workspaces
SET
  link_sharing_enabled = CASE
    WHEN plan = 'plus' THEN 1
    ELSE 0
  END,
  external_posting_enabled = CASE
    WHEN plan IN ('plus', 'team') THEN 1
    ELSE 0
  END;

-- Existing link shares are evidence that the workspace already relied on
-- anonymous links. Preserve that capability and their unlimited lifetime during
-- migration; plan checks still gate Free at read/write time.
UPDATE workspaces AS w
SET link_sharing_enabled = 1,
    link_expiry_max_days = NULL
WHERE w.id IN (
  SELECT DISTINCT s.workspace_id
  FROM shareables AS s
  WHERE s.visibility = 'link'
);
