ALTER TABLE comment_anchors ADD COLUMN selector_format TEXT CHECK (selector_format IS NULL OR selector_format IN ('normalized-v1', 'quote-v1'));
ALTER TABLE comment_anchors ADD COLUMN text_hash TEXT;
ALTER TABLE comment_anchors ADD COLUMN ambiguous_at_creation INTEGER CHECK (ambiguous_at_creation IS NULL OR ambiguous_at_creation IN (0, 1));

CREATE TABLE comment_anchor_results (
  anchor_id TEXT NOT NULL REFERENCES comment_anchors(id) ON DELETE CASCADE,
  version_id TEXT NOT NULL REFERENCES versions(id) ON DELETE CASCADE,
  target_path TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('attached', 'needs-check')),
  hint_start INTEGER,
  hint_end INTEGER,
  text_hash TEXT,
  frame_token TEXT NOT NULL,
  generation INTEGER NOT NULL CHECK (generation >= 0),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (anchor_id, version_id, target_path),
  CHECK ((hint_start IS NOT NULL AND hint_end IS NOT NULL AND hint_start >= 0 AND hint_end > hint_start AND text_hash IS NOT NULL) OR
    (state = 'needs-check' AND hint_start IS NULL AND hint_end IS NULL AND text_hash IS NULL))
);

CREATE INDEX idx_comment_anchor_results_version_id ON comment_anchor_results(version_id);
