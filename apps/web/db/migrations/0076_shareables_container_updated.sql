CREATE INDEX shareables_container_updated
  ON shareables(container_id, updated_at DESC, id DESC);
CREATE INDEX shareables_workspace_owner_updated
  ON shareables(workspace_id, owner_user_id, updated_at DESC, id DESC);
