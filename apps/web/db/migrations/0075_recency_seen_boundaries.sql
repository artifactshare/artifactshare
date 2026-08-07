ALTER TABLE shareable_viewer_recency ADD COLUMN version_seen_through_at TEXT;
ALTER TABLE shareable_viewer_recency ADD COLUMN comment_seen_through_at TEXT;
UPDATE shareable_viewer_recency
SET version_seen_through_at = last_viewed_at,
    comment_seen_through_at = last_viewed_at;
