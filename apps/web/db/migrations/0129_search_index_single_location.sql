-- Every workspace search index runs in one location, so where each was
-- placed and when it reported ready are no longer recorded.
ALTER TABLE search_index_workspaces DROP COLUMN location_hint;
ALTER TABLE search_index_workspaces DROP COLUMN ready_at;
