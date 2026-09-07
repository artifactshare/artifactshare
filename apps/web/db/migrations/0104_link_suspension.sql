-- Operators can pause a link share while they review it. The pause is a
-- column on the shareable (the anonymous link host answers "paused" while it
-- is set; the owner keeps every other access), and the pause, the resume,
-- and the owner's appeal are events. Nothing pauses a link automatically.
ALTER TABLE shareables ADD COLUMN link_suspended_at TEXT;
ALTER TABLE shareables ADD COLUMN link_suspended_reason TEXT;

-- Widen the event type CHECK; rebuild the table to keep every row.
CREATE TABLE events_next (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN (
    'artifact_created',
    'version_published',
    'comment_posted',
    'artifact_viewed',
    'visibility_changed',
    'link_reported',
    'link_suspended',
    'link_resumed',
    'link_appealed'
  )),
  shareable_id TEXT NOT NULL REFERENCES shareables(id) ON DELETE CASCADE,
  actor_user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  subject_id TEXT,
  payload TEXT CHECK (payload IS NULL OR json_valid(payload)),
  created_at TEXT NOT NULL,
  CHECK ((type = 'artifact_viewed') = (subject_id IS NULL)),
  CHECK (type IN ('artifact_viewed', 'link_reported', 'link_suspended', 'link_resumed') OR actor_user_id IS NOT NULL),
  CHECK (type NOT IN ('link_reported', 'link_suspended', 'link_resumed') OR actor_user_id IS NULL),
  CHECK (type NOT IN ('visibility_changed', 'link_reported', 'link_suspended', 'link_resumed', 'link_appealed') OR payload IS NOT NULL)
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
  payload,
  created_at
FROM events;

DROP TABLE events;
ALTER TABLE events_next RENAME TO events;

CREATE UNIQUE INDEX events_type_subject ON events(type, subject_id) WHERE subject_id IS NOT NULL;
CREATE INDEX events_workspace_created ON events(workspace_id, created_at DESC, id);
CREATE INDEX events_shareable_created ON events(shareable_id, created_at DESC);
CREATE INDEX events_type_created ON events(type, created_at);
CREATE INDEX events_type_workspace_shareable ON events(type, workspace_id, shareable_id);
