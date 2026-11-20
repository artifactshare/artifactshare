-- Caller routing is proportional to relationships, including historical ownership.
CREATE TABLE search_owner_workspaces (
  actor_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  file_count INTEGER NOT NULL CHECK(typeof(file_count) = 'integer' AND file_count >= 0),
  PRIMARY KEY(actor_id, workspace_id)
);
INSERT INTO search_owner_workspaces(actor_id,workspace_id,file_count)
SELECT owner_user_id,workspace_id,count(*) FROM shareables GROUP BY owner_user_id,workspace_id;
CREATE TRIGGER search_owner_insert AFTER INSERT ON shareables BEGIN
  INSERT INTO search_owner_workspaces(actor_id,workspace_id,file_count) VALUES(NEW.owner_user_id,NEW.workspace_id,1)
  ON CONFLICT(actor_id,workspace_id) DO UPDATE SET file_count=file_count+1;
END;
CREATE TRIGGER search_owner_delete AFTER DELETE ON shareables BEGIN
  UPDATE search_owner_workspaces SET file_count=file_count-1 WHERE actor_id=OLD.owner_user_id AND workspace_id=OLD.workspace_id;
  DELETE FROM search_owner_workspaces WHERE actor_id=OLD.owner_user_id AND workspace_id=OLD.workspace_id AND file_count=0;
END;
CREATE TRIGGER search_owner_update AFTER UPDATE OF owner_user_id,workspace_id ON shareables
WHEN OLD.owner_user_id IS NOT NEW.owner_user_id OR OLD.workspace_id IS NOT NEW.workspace_id BEGIN
  UPDATE search_owner_workspaces SET file_count=file_count-1 WHERE actor_id=OLD.owner_user_id AND workspace_id=OLD.workspace_id;
  DELETE FROM search_owner_workspaces WHERE actor_id=OLD.owner_user_id AND workspace_id=OLD.workspace_id AND file_count=0;
  INSERT INTO search_owner_workspaces(actor_id,workspace_id,file_count) VALUES(NEW.owner_user_id,NEW.workspace_id,1)
  ON CONFLICT(actor_id,workspace_id) DO UPDATE SET file_count=file_count+1;
END;
-- Separate typed feed: prior readers cannot acknowledge these keys.
CREATE TABLE search_index_policy_changes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('container','workspace')),
  policy_key TEXT NOT NULL,
  UNIQUE(workspace_id,kind,policy_key)
);
CREATE INDEX search_index_policy_workspace ON search_index_policy_changes(workspace_id,id);
CREATE TRIGGER search_index_policy_ready BEFORE INSERT ON search_index_policy_changes BEGIN
  INSERT INTO search_index_ready(workspace_id) VALUES(NEW.workspace_id) ON CONFLICT(workspace_id) DO NOTHING;
END;
DROP TRIGGER search_index_shareable_update;
CREATE TRIGGER search_index_shareable_update AFTER UPDATE ON shareables
WHEN OLD.id IS NOT NEW.id OR OLD.workspace_id IS NOT NEW.workspace_id OR OLD.current_version_id IS NOT NEW.current_version_id OR OLD.title_override IS NOT NEW.title_override OR OLD.derived_title IS NOT NEW.derived_title OR OLD.name IS NOT NEW.name OR OLD.description IS NOT NEW.description OR OLD.container_id IS NOT NEW.container_id OR OLD.owner_user_id IS NOT NEW.owner_user_id OR OLD.updated_at IS NOT NEW.updated_at OR OLD.activity_at IS NOT NEW.activity_at OR OLD.visibility IS NOT NEW.visibility OR OLD.link_expires_at IS NOT NEW.link_expires_at OR OLD.link_suspended_at IS NOT NEW.link_suspended_at BEGIN
  INSERT INTO search_index_changes(workspace_id,shareable_id) SELECT OLD.workspace_id,OLD.id WHERE OLD.workspace_id IS NOT NEW.workspace_id OR OLD.id IS NOT NEW.id ON CONFLICT(workspace_id,shareable_id) DO UPDATE SET id=excluded.id, recorded_at=excluded.recorded_at;
  INSERT INTO search_index_changes(workspace_id,shareable_id) VALUES(NEW.workspace_id,NEW.id) ON CONFLICT(workspace_id,shareable_id) DO UPDATE SET id=excluded.id, recorded_at=excluded.recorded_at;
END;
CREATE TRIGGER search_policy_artifact_containers_insert AFTER INSERT ON artifact_containers BEGIN
  INSERT INTO search_index_policy_changes(workspace_id,kind,policy_key) VALUES(NEW.workspace_id,'container',NEW.id) ON CONFLICT(workspace_id,kind,policy_key) DO UPDATE SET id=excluded.id;
END;
CREATE TRIGGER search_policy_artifact_containers_update AFTER UPDATE ON artifact_containers
WHEN OLD.workspace_id IS NOT NEW.workspace_id OR OLD.id IS NOT NEW.id OR OLD.kind IS NOT NEW.kind
  OR OLD.base_visibility IS NOT NEW.base_visibility OR OLD.created_by_id IS NOT NEW.created_by_id
  OR OLD.archived_at IS NOT NEW.archived_at BEGIN
  INSERT INTO search_index_policy_changes(workspace_id,kind,policy_key)
    SELECT OLD.workspace_id,'container',OLD.id WHERE OLD.workspace_id IS NOT NEW.workspace_id OR OLD.id IS NOT NEW.id
    ON CONFLICT(workspace_id,kind,policy_key) DO UPDATE SET id=excluded.id;
  INSERT INTO search_index_policy_changes(workspace_id,kind,policy_key) VALUES(NEW.workspace_id,'container',NEW.id) ON CONFLICT(workspace_id,kind,policy_key) DO UPDATE SET id=excluded.id;
END;
CREATE TRIGGER search_policy_artifact_containers_delete AFTER DELETE ON artifact_containers BEGIN
  INSERT INTO search_index_policy_changes(workspace_id,kind,policy_key) VALUES(OLD.workspace_id,'container',OLD.id) ON CONFLICT(workspace_id,kind,policy_key) DO UPDATE SET id=excluded.id;
END;
CREATE TRIGGER search_policy_workspaces_insert AFTER INSERT ON workspaces BEGIN
  INSERT INTO search_index_policy_changes(workspace_id,kind,policy_key) VALUES(NEW.id,'workspace',NEW.id) ON CONFLICT(workspace_id,kind,policy_key) DO UPDATE SET id=excluded.id;
END;
CREATE TRIGGER search_policy_workspaces_update AFTER UPDATE ON workspaces
WHEN OLD.id IS NOT NEW.id OR OLD.link_sharing_enabled IS NOT NEW.link_sharing_enabled BEGIN
  INSERT INTO search_index_policy_changes(workspace_id,kind,policy_key)
    SELECT OLD.id,'workspace',OLD.id WHERE OLD.id IS NOT NEW.id
    ON CONFLICT(workspace_id,kind,policy_key) DO UPDATE SET id=excluded.id;
  INSERT INTO search_index_policy_changes(workspace_id,kind,policy_key) VALUES(NEW.id,'workspace',NEW.id) ON CONFLICT(workspace_id,kind,policy_key) DO UPDATE SET id=excluded.id;
END;
CREATE TRIGGER search_policy_workspaces_delete AFTER DELETE ON workspaces BEGIN
  INSERT INTO search_index_policy_changes(workspace_id,kind,policy_key) VALUES(OLD.id,'workspace',OLD.id) ON CONFLICT(workspace_id,kind,policy_key) DO UPDATE SET id=excluded.id;
END;
CREATE TRIGGER search_policy_project_members_insert AFTER INSERT ON project_members BEGIN
  INSERT INTO search_index_policy_changes(workspace_id,kind,policy_key) SELECT workspace_id,'container',id FROM artifact_containers WHERE id=NEW.container_id ON CONFLICT(workspace_id,kind,policy_key) DO UPDATE SET id=excluded.id;
END;
CREATE TRIGGER search_policy_project_members_update AFTER UPDATE ON project_members BEGIN
  INSERT INTO search_index_policy_changes(workspace_id,kind,policy_key) SELECT workspace_id,'container',id FROM artifact_containers WHERE id=OLD.container_id ON CONFLICT(workspace_id,kind,policy_key) DO UPDATE SET id=excluded.id;
  INSERT INTO search_index_policy_changes(workspace_id,kind,policy_key) SELECT workspace_id,'container',id FROM artifact_containers WHERE id=NEW.container_id ON CONFLICT(workspace_id,kind,policy_key) DO UPDATE SET id=excluded.id;
END;
CREATE TRIGGER search_policy_project_members_delete AFTER DELETE ON project_members BEGIN
  INSERT INTO search_index_policy_changes(workspace_id,kind,policy_key) SELECT workspace_id,'container',id FROM artifact_containers WHERE id=OLD.container_id ON CONFLICT(workspace_id,kind,policy_key) DO UPDATE SET id=excluded.id;
END;
CREATE TRIGGER search_policy_project_share_defaults_insert AFTER INSERT ON project_share_defaults BEGIN
  INSERT INTO search_index_policy_changes(workspace_id,kind,policy_key) SELECT workspace_id,'container',id FROM artifact_containers WHERE id=NEW.project_container_id ON CONFLICT(workspace_id,kind,policy_key) DO UPDATE SET id=excluded.id;
END;
CREATE TRIGGER search_policy_project_share_defaults_update AFTER UPDATE ON project_share_defaults BEGIN
  INSERT INTO search_index_policy_changes(workspace_id,kind,policy_key) SELECT workspace_id,'container',id FROM artifact_containers WHERE id=OLD.project_container_id ON CONFLICT(workspace_id,kind,policy_key) DO UPDATE SET id=excluded.id;
  INSERT INTO search_index_policy_changes(workspace_id,kind,policy_key) SELECT workspace_id,'container',id FROM artifact_containers WHERE id=NEW.project_container_id ON CONFLICT(workspace_id,kind,policy_key) DO UPDATE SET id=excluded.id;
END;
CREATE TRIGGER search_policy_project_share_defaults_delete AFTER DELETE ON project_share_defaults BEGIN
  INSERT INTO search_index_policy_changes(workspace_id,kind,policy_key) SELECT workspace_id,'container',id FROM artifact_containers WHERE id=OLD.project_container_id ON CONFLICT(workspace_id,kind,policy_key) DO UPDATE SET id=excluded.id;
END;
CREATE TRIGGER search_policy_grant_insert AFTER INSERT ON shareable_grants BEGIN
  INSERT INTO search_index_changes(workspace_id,shareable_id) SELECT workspace_id,id FROM shareables WHERE id=NEW.shareable_id ON CONFLICT(workspace_id,shareable_id) DO UPDATE SET id=excluded.id,recorded_at=excluded.recorded_at;
END;
CREATE TRIGGER search_policy_grant_update AFTER UPDATE ON shareable_grants BEGIN
  INSERT INTO search_index_changes(workspace_id,shareable_id) SELECT workspace_id,id FROM shareables WHERE id=OLD.shareable_id ON CONFLICT(workspace_id,shareable_id) DO UPDATE SET id=excluded.id,recorded_at=excluded.recorded_at;
  INSERT INTO search_index_changes(workspace_id,shareable_id) SELECT workspace_id,id FROM shareables WHERE id=NEW.shareable_id ON CONFLICT(workspace_id,shareable_id) DO UPDATE SET id=excluded.id,recorded_at=excluded.recorded_at;
END;
CREATE TRIGGER search_policy_grant_delete AFTER DELETE ON shareable_grants BEGIN
  INSERT INTO search_index_changes(workspace_id,shareable_id) SELECT workspace_id,id FROM shareables WHERE id=OLD.shareable_id ON CONFLICT(workspace_id,shareable_id) DO UPDATE SET id=excluded.id,recorded_at=excluded.recorded_at;
END;
INSERT INTO search_index_rebuilds(target) VALUES(13);
