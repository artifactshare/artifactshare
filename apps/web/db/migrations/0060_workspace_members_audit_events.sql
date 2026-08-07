-- Migration: 0060_workspace_members_audit_events
-- Created: 2026-07-12
-- Description: Expand membership into workspace_members and generalize audit into
-- audit_events. Backfills from users + workspace_admins + workspace_contributors and
-- from shareable_delete_events. Old tables are kept for a follow-up contract migration.
-- Mirrors db/schema.sql; keep both in sync.

CREATE TABLE workspace_members (
  workspace_id          TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id               TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role                  TEXT NOT NULL DEFAULT 'member'
                        CHECK (role IN ('admin', 'member')),
  status                TEXT NOT NULL DEFAULT 'active'
                        CHECK (status IN ('active', 'suspended', 'removed')),
  first_contributed_at  TEXT,
  last_contributed_at   TEXT,
  pending_uploads       INTEGER NOT NULL DEFAULT 0,
  suspended_at          TEXT,
  suspended_by          TEXT REFERENCES users(id) ON DELETE SET NULL,
  removed_at            TEXT,
  removed_by            TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL,
  PRIMARY KEY (workspace_id, user_id)
);
CREATE INDEX workspace_members_user ON workspace_members(user_id, status);
CREATE INDEX workspace_members_workspace_status ON workspace_members(workspace_id, status);
CREATE UNIQUE INDEX workspace_members_single_admin
  ON workspace_members(workspace_id) WHERE role = 'admin';

INSERT INTO workspace_members (
  workspace_id,
  user_id,
  role,
  status,
  first_contributed_at,
  last_contributed_at,
  pending_uploads,
  suspended_at,
  suspended_by,
  created_at,
  updated_at
)
SELECT
  u.workspace_id,
  u.id,
  CASE WHEN wa.user_id IS NOT NULL THEN 'admin' ELSE 'member' END,
  CASE
    WHEN wa.user_id IS NOT NULL THEN 'active'
    WHEN wc.upload_suspended_at IS NOT NULL THEN 'suspended'
    ELSE 'active'
  END,
  wc.first_contributed_at,
  wc.last_contributed_at,
  COALESCE(wc.pending_uploads, 0),
  wc.upload_suspended_at,
  wc.upload_suspended_by,
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM users u
LEFT JOIN workspace_admins wa
  ON wa.workspace_id = u.workspace_id AND wa.user_id = u.id
LEFT JOIN workspace_contributors wc
  ON wc.workspace_id = u.workspace_id AND wc.user_id = u.id;

CREATE TABLE audit_events (
  id             TEXT PRIMARY KEY,
  workspace_id   TEXT NOT NULL,
  actor_user_id  TEXT REFERENCES users(id) ON DELETE SET NULL,
  action         TEXT NOT NULL,
  subject_type   TEXT NOT NULL,
  subject_id     TEXT NOT NULL,
  detail         TEXT,
  created_at     TEXT NOT NULL
);
CREATE INDEX audit_events_workspace_created ON audit_events(workspace_id, created_at DESC);

INSERT INTO audit_events (
  id,
  workspace_id,
  actor_user_id,
  action,
  subject_type,
  subject_id,
  detail,
  created_at
)
SELECT
  id,
  workspace_id,
  deleted_by,
  'artifact.delete',
  'shareable',
  shareable_id,
  json_object(
    'name', shareable_name,
    'project_container_id', project_container_id,
    'owner_user_id', owner_user_id
  ),
  deleted_at
FROM shareable_delete_events;
