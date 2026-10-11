CREATE TABLE version_retention_tombstones (
  version_id TEXT PRIMARY KEY NOT NULL,
  shareable_id TEXT NOT NULL REFERENCES shareables(id) ON DELETE CASCADE,
  version_number INTEGER NOT NULL,
  removed_at TEXT NOT NULL
);
CREATE INDEX idx_version_retention_tombstones_shareable ON version_retention_tombstones(shareable_id);
