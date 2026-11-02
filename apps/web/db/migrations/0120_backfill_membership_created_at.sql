-- Migration 0060 created workspace_members by inserting one row per existing
-- user, stamped with the migration time instead of the time the user joined.
-- Before 0060 every user belonged only to their home workspace, so that
-- membership began when the user was created. Restore the user's creation
-- time on those backfilled rows: they share the table's earliest created_at,
-- belong to the user's home workspace, and record a time after the user's
-- creation. Rows written by the application since 0060 are left unchanged.
UPDATE workspace_members
SET created_at = (
  SELECT u.created_at FROM users u WHERE u.id = workspace_members.user_id
)
WHERE created_at = (SELECT MIN(created_at) FROM workspace_members)
  AND EXISTS (
    SELECT 1 FROM users u
    WHERE u.id = workspace_members.user_id
      AND u.workspace_id = workspace_members.workspace_id
      AND julianday(u.created_at) < julianday(workspace_members.created_at)
  );
