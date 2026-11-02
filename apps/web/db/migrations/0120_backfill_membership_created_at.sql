-- Migration 0060 (2026-07-12) created workspace_members by inserting one row
-- per existing user in a single statement, stamped with the migration time
-- instead of the time the user joined. Before 0060 every user belonged only
-- to their home workspace, so that membership began when the user was
-- created. Restore the user's creation time on those backfilled rows.
--
-- The backfilled rows are identified conservatively. Their shared created_at
-- must be the table's earliest value, fall on or before 2026-07-12 (no later
-- application write can predate 0060), and be shared by more than one row
-- (the application stamps each membership separately). A database where 0060
-- ran on an empty users table, or where no backfilled row survives, matches
-- nothing and is left unchanged. Each updated row must also belong to the
-- user's home workspace and record a time after the user's creation.
WITH backfill AS (
  SELECT created_at FROM workspace_members
  WHERE created_at = (SELECT MIN(created_at) FROM workspace_members)
    AND julianday(created_at) < julianday('2026-07-13')
  GROUP BY created_at
  HAVING COUNT(*) > 1
)
UPDATE workspace_members
SET created_at = (
  SELECT u.created_at FROM users u WHERE u.id = workspace_members.user_id
)
WHERE created_at IN (SELECT created_at FROM backfill)
  AND EXISTS (
    SELECT 1 FROM users u
    WHERE u.id = workspace_members.user_id
      AND u.workspace_id = workspace_members.workspace_id
      AND julianday(u.created_at) < julianday(workspace_members.created_at)
  );
