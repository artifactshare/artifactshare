CREATE TABLE workspace_contributors (
  workspace_id           TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id                TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  first_contributed_at   TEXT,
  last_contributed_at    TEXT,
  pending_uploads        INTEGER NOT NULL DEFAULT 0,
  created_at             TEXT NOT NULL,
  updated_at             TEXT NOT NULL,
  PRIMARY KEY (workspace_id, user_id)
);
CREATE INDEX workspace_contributors_user_id ON workspace_contributors(user_id);

INSERT INTO workspace_contributors (
  workspace_id,
  user_id,
  first_contributed_at,
  last_contributed_at,
  pending_uploads,
  created_at,
  updated_at
)
SELECT
  shareables.workspace_id,
  versions.created_by_id,
  MIN(COALESCE(versions.published_at, versions.created_at)),
  MAX(COALESCE(versions.published_at, versions.created_at)),
  0,
  MIN(COALESCE(versions.published_at, versions.created_at)),
  MAX(COALESCE(versions.published_at, versions.created_at))
FROM versions
INNER JOIN shareables ON shareables.id = versions.shareable_id
WHERE versions.status = 'published'
GROUP BY shareables.workspace_id, versions.created_by_id;
