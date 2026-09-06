-- Link-share safety needs structured report and visibility-change events.
-- Rebuild the table to widen its CHECK constraints while preserving all rows.
CREATE TABLE events_next (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN (
    'artifact_created',
    'version_published',
    'comment_posted',
    'artifact_viewed',
    'visibility_changed',
    'link_reported'
  )),
  shareable_id TEXT NOT NULL REFERENCES shareables(id) ON DELETE CASCADE,
  actor_user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  subject_id TEXT,
  payload TEXT CHECK (payload IS NULL OR json_valid(payload)),
  created_at TEXT NOT NULL,
  CHECK ((type = 'artifact_viewed') = (subject_id IS NULL)),
  CHECK (type IN ('artifact_viewed', 'link_reported') OR actor_user_id IS NOT NULL),
  CHECK (type <> 'link_reported' OR actor_user_id IS NULL),
  CHECK (type NOT IN ('visibility_changed', 'link_reported') OR payload IS NOT NULL)
);

INSERT INTO events_next (
  id,
  workspace_id,
  type,
  shareable_id,
  actor_user_id,
  subject_id,
  payload,
  created_at
)
SELECT
  id,
  workspace_id,
  type,
  shareable_id,
  actor_user_id,
  subject_id,
  NULL,
  created_at
FROM events;

DROP TABLE events;
ALTER TABLE events_next RENAME TO events;

CREATE UNIQUE INDEX events_type_subject ON events(type, subject_id) WHERE subject_id IS NOT NULL;
CREATE INDEX events_workspace_created ON events(workspace_id, created_at DESC, id);
CREATE INDEX events_shareable_created ON events(shareable_id, created_at DESC);
CREATE INDEX events_type_created ON events(type, created_at);
CREATE INDEX events_type_workspace_shareable ON events(type, workspace_id, shareable_id);

CREATE INDEX shareables_workspace_visibility ON shareables(workspace_id, visibility);
