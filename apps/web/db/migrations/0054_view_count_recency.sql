CREATE TABLE shareable_viewer_recency (
  shareable_id         TEXT NOT NULL REFERENCES shareables(id) ON DELETE CASCADE,
  viewer_user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  first_viewed_at      TEXT NOT NULL,
  last_viewed_at       TEXT NOT NULL,
  effective_view_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (shareable_id, viewer_user_id)
);
CREATE INDEX shareable_viewer_recency_viewer_time
  ON shareable_viewer_recency(viewer_user_id, last_viewed_at DESC);

INSERT INTO shareable_viewer_recency (
  shareable_id,
  viewer_user_id,
  first_viewed_at,
  last_viewed_at,
  effective_view_count
)
SELECT
  shareable_id,
  viewer_user_id,
  MIN(viewed_at),
  MAX(viewed_at),
  COUNT(*)
FROM views
GROUP BY shareable_id, viewer_user_id;

DROP TABLE views;
DROP TABLE views_anon;
