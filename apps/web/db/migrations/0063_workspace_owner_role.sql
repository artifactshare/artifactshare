-- Widen workspace membership roles for the owner/admin compatibility layer.

DROP INDEX workspace_members_user;
DROP INDEX workspace_members_workspace_status;
DROP INDEX workspace_members_single_admin;
ALTER TABLE workspace_members RENAME TO workspace_members_legacy;

CREATE TABLE workspace_members (
  workspace_id          TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id               TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role                  TEXT NOT NULL DEFAULT 'member'
                        CHECK (role IN ('owner', 'admin', 'member')),
  status                TEXT NOT NULL DEFAULT 'active'
                        CHECK (status IN ('active', 'removed')),
  first_contributed_at  TEXT,
  last_contributed_at   TEXT,
  pending_uploads       INTEGER NOT NULL DEFAULT 0,
  removed_at            TEXT,
  removed_by            TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL,
  PRIMARY KEY (workspace_id, user_id)
);

INSERT INTO workspace_members (
  workspace_id, user_id, role, status, first_contributed_at,
  last_contributed_at, pending_uploads, removed_at, removed_by,
  created_at, updated_at
)
SELECT
  workspace_id, user_id, role, status, first_contributed_at,
  last_contributed_at, pending_uploads, removed_at, removed_by,
  created_at, updated_at
FROM workspace_members_legacy;

DROP TABLE workspace_members_legacy;

CREATE INDEX workspace_members_user ON workspace_members(user_id, status);
CREATE INDEX workspace_members_workspace_status ON workspace_members(workspace_id, status);
CREATE UNIQUE INDEX workspace_members_single_admin
  ON workspace_members(workspace_id) WHERE role = 'admin';
CREATE UNIQUE INDEX workspace_members_single_owner
  ON workspace_members(workspace_id) WHERE role = 'owner';
