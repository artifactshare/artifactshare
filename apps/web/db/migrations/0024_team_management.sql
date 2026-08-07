CREATE TABLE workspace_admins (
  workspace_id  TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
CREATE INDEX workspace_admins_user_id ON workspace_admins(user_id);

INSERT INTO workspace_admins (workspace_id, user_id, created_at, updated_at)
SELECT
  ranked.workspace_id,
  ranked.id,
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM (
  SELECT
    users.workspace_id,
    users.id,
    ROW_NUMBER() OVER (
      PARTITION BY users.workspace_id
      ORDER BY
        CASE WHEN workspace_contributors.first_contributed_at IS NULL THEN 1 ELSE 0 END ASC,
        workspace_contributors.first_contributed_at ASC,
        users.created_at ASC,
        users.id ASC
    ) AS rn
  FROM users
  INNER JOIN workspaces ON workspaces.id = users.workspace_id
  LEFT JOIN workspace_contributors
    ON workspace_contributors.workspace_id = users.workspace_id
   AND workspace_contributors.user_id = users.id
  WHERE workspaces.plan = 'team'
) AS ranked
WHERE ranked.rn = 1;

ALTER TABLE workspace_contributors
  ADD COLUMN upload_suspended_at TEXT;

ALTER TABLE workspace_contributors
  ADD COLUMN upload_suspended_by TEXT REFERENCES users(id) ON DELETE SET NULL;

CREATE INDEX workspace_contributors_upload_suspended
  ON workspace_contributors(workspace_id, upload_suspended_at);
