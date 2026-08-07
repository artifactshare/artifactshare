ALTER TABLE slack_workspaces
  ADD COLUMN workspace_id TEXT REFERENCES workspaces(id) ON DELETE CASCADE;

UPDATE slack_workspaces
SET workspace_id = (
  SELECT u.workspace_id
  FROM users AS u
  WHERE u.id = slack_workspaces.installed_by_user_id
)
WHERE installed_by_user_id IS NOT NULL;

CREATE INDEX slack_workspaces_workspace_id
  ON slack_workspaces(workspace_id);
