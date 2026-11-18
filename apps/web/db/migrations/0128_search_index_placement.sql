-- Each workspace's search index is created near its members. The location
-- hint is recorded once; ready_at marks when the placed index finished its
-- first full reconciliation.
ALTER TABLE search_index_workspaces ADD COLUMN location_hint TEXT;
ALTER TABLE search_index_workspaces ADD COLUMN ready_at TEXT;
