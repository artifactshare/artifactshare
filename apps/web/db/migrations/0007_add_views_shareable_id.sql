-- Additive: add views.shareable_id column with FK to shareables, backfill
-- from artifact_id (1:1 since shareables.id = artifacts.id post-0006).
-- views.artifact_id stays in place until the contract PR (0008) rebuilds.
ALTER TABLE views ADD COLUMN shareable_id TEXT REFERENCES shareables(id) ON DELETE CASCADE;

UPDATE views SET shareable_id = artifact_id;

CREATE INDEX views_shareable_viewer_time
  ON views(shareable_id, viewer_user_id, viewed_at DESC);
