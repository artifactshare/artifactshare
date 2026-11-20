-- Additive cutover: the old registry and its callers remain valid until Worker replacement.
-- No source/workspace foreign keys: tombstones must survive parent cascades.
CREATE TABLE search_index_changes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id TEXT NOT NULL,
  shareable_id TEXT NOT NULL,
  recorded_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE(workspace_id, shareable_id)
);
CREATE INDEX search_index_changes_workspace ON search_index_changes(workspace_id, id);
CREATE TABLE search_index_ready (
  workspace_id TEXT PRIMARY KEY,
  dispatched_at TEXT NOT NULL DEFAULT ''
);
CREATE INDEX search_index_ready_dispatch ON search_index_ready(dispatched_at, workspace_id);
-- Retain completed targets, including after seeding, to fence older Workers on rollback.
CREATE TABLE search_index_rebuilds (
  target INTEGER PRIMARY KEY,
  phase TEXT NOT NULL DEFAULT 'live' CHECK(phase IN ('live','legacy','done')),
  cursor TEXT NOT NULL DEFAULT ''
);
CREATE TABLE search_index_workspace_rebuilds (
  workspace_id TEXT PRIMARY KEY,
  target INTEGER NOT NULL,
  completed INTEGER NOT NULL DEFAULT 0 CHECK(completed IN (0,1))
);
CREATE TRIGGER search_index_changes_ready AFTER INSERT ON search_index_changes BEGIN
  INSERT INTO search_index_ready(workspace_id) VALUES(NEW.workspace_id) ON CONFLICT(workspace_id) DO NOTHING;
END;
CREATE TRIGGER search_index_rebuild_ready AFTER INSERT ON search_index_workspace_rebuilds BEGIN
  INSERT INTO search_index_ready(workspace_id) VALUES(NEW.workspace_id) ON CONFLICT(workspace_id) DO NOTHING;
END;
CREATE TRIGGER search_index_rebuild_updated AFTER UPDATE OF target ON search_index_workspace_rebuilds
WHEN NEW.target IS NOT OLD.target BEGIN
  INSERT INTO search_index_ready(workspace_id) VALUES(NEW.workspace_id) ON CONFLICT(workspace_id) DO NOTHING;
END;
-- REPLACE allocates a fresh AUTOINCREMENT identity even when coalescing an item.
CREATE TRIGGER search_index_shareable_insert AFTER INSERT ON shareables BEGIN
  INSERT OR REPLACE INTO search_index_changes(workspace_id,shareable_id) VALUES(NEW.workspace_id,NEW.id);
END;
CREATE TRIGGER search_index_shareable_update AFTER UPDATE ON shareables
WHEN OLD.id IS NOT NEW.id OR OLD.workspace_id IS NOT NEW.workspace_id OR OLD.current_version_id IS NOT NEW.current_version_id OR OLD.title_override IS NOT NEW.title_override OR OLD.derived_title IS NOT NEW.derived_title OR OLD.name IS NOT NEW.name OR OLD.description IS NOT NEW.description OR OLD.container_id IS NOT NEW.container_id OR OLD.owner_user_id IS NOT NEW.owner_user_id OR OLD.updated_at IS NOT NEW.updated_at OR OLD.activity_at IS NOT NEW.activity_at BEGIN
  INSERT OR REPLACE INTO search_index_changes(workspace_id,shareable_id) SELECT OLD.workspace_id,OLD.id WHERE OLD.workspace_id IS NOT NEW.workspace_id OR OLD.id IS NOT NEW.id;
  INSERT OR REPLACE INTO search_index_changes(workspace_id,shareable_id) VALUES(NEW.workspace_id,NEW.id);
END;
CREATE TRIGGER search_index_shareable_delete AFTER DELETE ON shareables BEGIN
  INSERT OR REPLACE INTO search_index_changes(workspace_id,shareable_id) VALUES(OLD.workspace_id,OLD.id);
END;
CREATE TRIGGER search_index_version_insert AFTER INSERT ON versions
BEGIN
  INSERT OR REPLACE INTO search_index_changes(workspace_id,shareable_id)
    SELECT s.workspace_id,s.id FROM shareables s WHERE s.current_version_id=NEW.id;
END;
CREATE TRIGGER search_index_version_update AFTER UPDATE ON versions
WHEN OLD.id IS NOT NEW.id OR OLD.artifact_kind IS NOT NEW.artifact_kind OR OLD.entrypoint_path IS NOT NEW.entrypoint_path OR OLD.r2_key IS NOT NEW.r2_key OR OLD.sha256 IS NOT NEW.sha256 OR OLD.status IS NOT NEW.status
BEGIN
  INSERT OR REPLACE INTO search_index_changes(workspace_id,shareable_id)
    SELECT s.workspace_id,s.id FROM shareables s WHERE s.current_version_id IN (OLD.id,NEW.id);
END;
CREATE TRIGGER search_index_version_delete BEFORE DELETE ON versions
BEGIN
  INSERT OR REPLACE INTO search_index_changes(workspace_id,shareable_id)
    SELECT s.workspace_id,s.id FROM shareables s WHERE s.current_version_id=OLD.id;
END;
-- version_files are immutable published manifests: all insertion/inheritance happens
-- in the publication batch, before current_version_id changes (or in the same batch
-- that inserts the shareable/version). Deletion is version retention/cascade; the
-- current-version delete trigger above covers it. No independent file edits exist.
-- Every future INDEX_FORMAT_VERSION increment must include a same-change migration:
-- INSERT INTO search_index_rebuilds(target) VALUES(<new format>);
INSERT INTO search_index_rebuilds(target) VALUES(12);
