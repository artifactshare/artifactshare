-- Agent CLI listings now scan by workspace (read scope covers the whole
-- workspace, not one container), so give the keyset pagination an index
-- matching (workspace_id, updated_at DESC, id DESC).
CREATE INDEX shareables_workspace_updated
  ON shareables(workspace_id, updated_at DESC, id DESC);
