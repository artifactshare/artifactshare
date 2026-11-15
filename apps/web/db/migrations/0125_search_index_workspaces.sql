-- Cleanup discovery must survive deletion of a source workspace.
CREATE TABLE search_index_workspaces (
  workspace_id TEXT PRIMARY KEY,
  dispatched_at TEXT NOT NULL DEFAULT ''
);
CREATE INDEX search_index_workspaces_dispatch ON search_index_workspaces(dispatched_at, workspace_id);
