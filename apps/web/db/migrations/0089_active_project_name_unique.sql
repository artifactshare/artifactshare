CREATE UNIQUE INDEX artifact_containers_active_project_name_unique
  ON artifact_containers(workspace_id, name COLLATE NOCASE)
  WHERE kind = 'project' AND archived_at IS NULL;
