ALTER TABLE workspaces ADD COLUMN plan TEXT NOT NULL DEFAULT 'free';
ALTER TABLE workspaces ADD COLUMN storage_quota_bytes INTEGER NOT NULL DEFAULT 104857600;
ALTER TABLE workspaces ADD COLUMN storage_used_bytes INTEGER NOT NULL DEFAULT 0;
ALTER TABLE workspaces ADD COLUMN storage_updated_at TEXT NOT NULL DEFAULT '1970-01-01T00:00:00.000Z';

UPDATE workspaces
SET plan = CASE
  WHEN EXISTS (
    SELECT 1 FROM users
    WHERE users.workspace_id = workspaces.id
      AND users.plan = 'team'
  ) THEN 'team'
  ELSE 'free'
END;

UPDATE workspaces
SET storage_quota_bytes = CASE plan
  WHEN 'team' THEN 53687091200
  ELSE 104857600
END;

UPDATE workspaces
SET storage_used_bytes = COALESCE((
  SELECT SUM(users.storage_used_bytes)
  FROM users
  WHERE users.workspace_id = workspaces.id
), 0);

UPDATE workspaces
SET storage_updated_at = COALESCE((
  SELECT MAX(users.updated_at)
  FROM users
  WHERE users.workspace_id = workspaces.id
), workspaces.created_at);

ALTER TABLE users DROP COLUMN plan;
ALTER TABLE users DROP COLUMN storage_quota_bytes;
ALTER TABLE users DROP COLUMN storage_used_bytes;
