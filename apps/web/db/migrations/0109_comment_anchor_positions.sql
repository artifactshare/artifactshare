-- Parent ids intentionally retain missing-version evidence after deletion.
ALTER TABLE versions ADD COLUMN previous_current_version_id TEXT;
ALTER TABLE versions ADD COLUMN anchor_lineage_recorded INTEGER NOT NULL DEFAULT 0
  CHECK (anchor_lineage_recorded IN (-1, 0, 1));

CREATE TRIGGER versions_anchor_lineage_insert AFTER INSERT ON versions
BEGIN
  UPDATE versions SET anchor_lineage_recorded = CASE WHEN EXISTS (
    SELECT 1 FROM shareables WHERE id = NEW.shareable_id AND current_version_id = NEW.id
  ) THEN 1 ELSE -1 END WHERE id = NEW.id;
END;

-- Capture the winning pointer write, covering every publication channel.
-- Only newly inserted, never-published versions are eligible. Restoring an
-- old version must not rewrite either recorded or unknown historical lineage.
CREATE TRIGGER shareables_anchor_lineage_update AFTER UPDATE OF current_version_id ON shareables
WHEN NEW.current_version_id IS NOT OLD.current_version_id
BEGIN
  UPDATE versions SET previous_current_version_id = OLD.current_version_id,
    anchor_lineage_recorded = 1
  WHERE id = NEW.current_version_id AND shareable_id = NEW.id AND anchor_lineage_recorded = -1;
END;

CREATE TABLE comment_anchor_positions (
  anchor_id TEXT NOT NULL REFERENCES comment_anchors(id) ON DELETE CASCADE,
  version_id TEXT NOT NULL REFERENCES versions(id) ON DELETE CASCADE,
  target_path TEXT NOT NULL,
  format TEXT NOT NULL,
  text_start INTEGER,
  text_end INTEGER,
  reason TEXT,
  PRIMARY KEY (anchor_id, version_id, target_path, format),
  CHECK ((reason IS NULL AND text_start IS NOT NULL AND text_end IS NOT NULL AND text_start >= 0 AND text_end > text_start)
    OR (reason IS NOT NULL AND text_start IS NULL AND text_end IS NULL))
);

CREATE TABLE comment_anchor_transitions (
  cache_key TEXT PRIMARY KEY,
  shareable_id TEXT NOT NULL REFERENCES shareables(id) ON DELETE CASCADE,
  edit_map TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX comment_anchor_transitions_created ON comment_anchor_transitions(created_at);

-- Retain canonical snapshots so a presentation/format change can be mapped
-- without mutating the origin anchor or guessing its old text by quote.
CREATE TABLE comment_anchor_documents (
  version_id TEXT NOT NULL REFERENCES versions(id) ON DELETE CASCADE,
  target_path TEXT NOT NULL,
  format TEXT NOT NULL,
  document TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (version_id, target_path, format)
);
CREATE INDEX comment_anchor_documents_created ON comment_anchor_documents(created_at);
