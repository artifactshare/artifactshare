CREATE TABLE events (
  id             TEXT PRIMARY KEY,
  workspace_id   TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  type           TEXT NOT NULL
    CHECK (type IN ('artifact_created', 'version_published', 'comment_posted', 'artifact_viewed')),
  shareable_id   TEXT NOT NULL REFERENCES shareables(id) ON DELETE CASCADE,
  actor_user_id  TEXT REFERENCES users(id) ON DELETE CASCADE,
  subject_id     TEXT,
  created_at     TEXT NOT NULL,
  CHECK ((type = 'artifact_viewed') = (subject_id IS NULL)),
  CHECK (type = 'artifact_viewed' OR actor_user_id IS NOT NULL)
);
CREATE UNIQUE INDEX events_type_subject ON events(type, subject_id) WHERE subject_id IS NOT NULL;
CREATE INDEX events_workspace_created ON events(workspace_id, created_at DESC, id);
CREATE INDEX events_shareable_created ON events(shareable_id, created_at DESC);
CREATE INDEX events_type_created ON events(type, created_at);

INSERT INTO events (id, workspace_id, type, shareable_id, actor_user_id, subject_id, created_at)
SELECT lower(hex(randomblob(16))), s.workspace_id, 'artifact_created', v.shareable_id,
       v.created_by_id, v.id, v.published_at
FROM versions v
JOIN shareables s ON s.id = v.shareable_id
WHERE v.status = 'published' AND v.published_at IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM versions earlier
    WHERE earlier.shareable_id = v.shareable_id
      AND earlier.status = 'published' AND earlier.published_at IS NOT NULL
      AND (earlier.published_at < v.published_at
        OR (earlier.published_at = v.published_at AND earlier.id < v.id))
  );

INSERT INTO events (id, workspace_id, type, shareable_id, actor_user_id, subject_id, created_at)
SELECT lower(hex(randomblob(16))), s.workspace_id, 'version_published', v.shareable_id,
       v.created_by_id, v.id, v.published_at
FROM versions v
JOIN shareables s ON s.id = v.shareable_id
WHERE v.status = 'published' AND v.published_at IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM versions earlier
    WHERE earlier.shareable_id = v.shareable_id
      AND earlier.status = 'published' AND earlier.published_at IS NOT NULL
      AND (earlier.published_at < v.published_at
        OR (earlier.published_at = v.published_at AND earlier.id < v.id))
  );

INSERT INTO events (id, workspace_id, type, shareable_id, actor_user_id, subject_id, created_at)
SELECT lower(hex(randomblob(16))), s.workspace_id, 'comment_posted', s.id,
       m.created_by_id, m.id, m.created_at
FROM comment_messages m
JOIN comment_threads t ON t.id = m.thread_id
JOIN shareables s ON s.id = t.shareable_id;
