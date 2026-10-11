ALTER TABLE shareables ADD COLUMN activity_at TEXT NOT NULL DEFAULT '';

-- Preserve rollout ordering, including artifacts whose old versions were pruned.
UPDATE shareables SET activity_at = updated_at;

CREATE TRIGGER shareables_initialize_activity
AFTER INSERT ON shareables
WHEN NEW.activity_at = ''
BEGIN
  UPDATE shareables SET activity_at = NEW.updated_at WHERE id = NEW.id;
END;

-- Column-restricted writes cannot recursively fire this trigger. Metadata writes
-- still count even when the unchanged current version belongs to a publisher.
CREATE TRIGGER shareables_update_activity
AFTER UPDATE OF updated_at ON shareables
WHEN NOT (
  OLD.current_version_id IS NOT NEW.current_version_id
  AND EXISTS (
    SELECT 1 FROM versions
    WHERE id = NEW.current_version_id AND shareable_id = NEW.id
      AND created_by_publisher_client_id IS NOT NULL
  )
)
BEGIN
  UPDATE shareables SET activity_at = NEW.updated_at WHERE id = NEW.id;
END;

CREATE INDEX shareables_container_activity
  ON shareables(container_id, activity_at DESC, id DESC);
CREATE INDEX shareables_workspace_owner_activity
  ON shareables(workspace_id, owner_user_id, activity_at DESC, id DESC);
CREATE INDEX shareables_workspace_activity
  ON shareables(workspace_id, activity_at DESC, id DESC);
