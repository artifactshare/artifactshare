CREATE TABLE comment_anchors (
  id            TEXT PRIMARY KEY,
  thread_id     TEXT NOT NULL UNIQUE REFERENCES comment_threads(id) ON DELETE CASCADE,
  version_id    TEXT REFERENCES versions(id) ON DELETE SET NULL,
  target_path   TEXT NOT NULL,
  quoted_text   TEXT NOT NULL,
  prefix_text   TEXT NOT NULL,
  suffix_text   TEXT NOT NULL,
  text_start    INTEGER NOT NULL,
  text_end      INTEGER NOT NULL,
  css_path      TEXT,
  created_at    TEXT NOT NULL
);
CREATE INDEX comment_anchors_version_path
  ON comment_anchors(version_id, target_path);
