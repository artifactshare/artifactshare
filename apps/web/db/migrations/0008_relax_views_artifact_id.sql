-- Hotfix: views.artifact_id was NOT NULL + FK to artifacts(id), but newly
-- registered shareables created via the v2 register flow don't insert a
-- corresponding artifacts row, so INSERT INTO views (... artifact_id = ?)
-- fails with a FK violation and recordView's writes silently drop in
-- waitUntil. Relax the column to NULLABLE without an FK so new views
-- record cleanly. Old code (if rolled back) would have failed already on
-- new shareables — the dual-write was useless because rolled-back code
-- can't see the new shareable rows anyway.
PRAGMA foreign_keys = OFF;

CREATE TABLE views_new (
  id              TEXT PRIMARY KEY,
  artifact_id     TEXT,
  shareable_id    TEXT NOT NULL REFERENCES shareables(id) ON DELETE CASCADE,
  viewer_user_id  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  viewed_at       TEXT NOT NULL,
  user_agent_hash TEXT
);

INSERT INTO views_new (id, artifact_id, shareable_id, viewer_user_id, viewed_at, user_agent_hash)
SELECT id, artifact_id, shareable_id, viewer_user_id, viewed_at, user_agent_hash FROM views;

DROP TABLE views;
ALTER TABLE views_new RENAME TO views;

CREATE INDEX views_artifact_viewer_time ON views(artifact_id, viewer_user_id, viewed_at DESC);
CREATE INDEX views_shareable_viewer_time ON views(shareable_id, viewer_user_id, viewed_at DESC);
CREATE INDEX views_viewer_time ON views(viewer_user_id, viewed_at DESC);

PRAGMA foreign_keys = ON;
