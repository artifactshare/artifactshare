CREATE TABLE first_post_analytics (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  channel TEXT,
  first_posted_at TEXT NOT NULL,
  CHECK (channel IS NULL OR channel IN ('web', 'cli', 'mcp'))
);
INSERT INTO first_post_analytics (user_id, channel, first_posted_at)
SELECT v.created_by_id, NULL, MIN(v.created_at) FROM versions v
WHERE v.created_at = (SELECT MIN(v2.created_at) FROM versions v2 WHERE v2.shareable_id = v.shareable_id)
GROUP BY v.created_by_id ON CONFLICT(user_id) DO NOTHING;
