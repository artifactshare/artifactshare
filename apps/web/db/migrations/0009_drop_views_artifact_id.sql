-- PR 2 (contract): drop views.artifact_id and finalize views to v2-only.
-- After 0008, artifact_id was relaxed to NULLABLE without FK and the
-- application code no longer reads or writes it. This migration rebuilds
-- the table without the column.
PRAGMA defer_foreign_keys = ON;

CREATE TABLE views_new (
  id              TEXT PRIMARY KEY,
  shareable_id    TEXT NOT NULL REFERENCES shareables(id) ON DELETE CASCADE,
  viewer_user_id  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  viewed_at       TEXT NOT NULL,
  user_agent_hash TEXT
);

INSERT INTO views_new (id, shareable_id, viewer_user_id, viewed_at, user_agent_hash)
SELECT id, shareable_id, viewer_user_id, viewed_at, user_agent_hash FROM views;

DROP TABLE views;
ALTER TABLE views_new RENAME TO views;

CREATE INDEX views_shareable_viewer_time ON views(shareable_id, viewer_user_id, viewed_at DESC);
CREATE INDEX views_viewer_time ON views(viewer_user_id, viewed_at DESC);

PRAGMA defer_foreign_keys = OFF;
