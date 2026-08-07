CREATE TABLE views_anon (
  id              TEXT PRIMARY KEY,
  shareable_id    TEXT NOT NULL REFERENCES shareables(id) ON DELETE CASCADE,
  viewer_ip_hash  TEXT NOT NULL,
  viewed_at       TEXT NOT NULL,
  user_agent_hash TEXT
);
CREATE INDEX views_anon_shareable_ip_time
  ON views_anon(shareable_id, viewer_ip_hash, viewed_at DESC);
