-- Viewer list: keyset pagination over a shareable's signed-in viewers ordered
-- by recency (last_viewed_at DESC, viewer_user_id DESC as the tiebreaker).
CREATE INDEX shareable_viewer_recency_shareable_time
  ON shareable_viewer_recency(shareable_id, last_viewed_at DESC, viewer_user_id DESC);
