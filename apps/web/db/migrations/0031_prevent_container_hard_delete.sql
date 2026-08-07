CREATE TRIGGER artifact_containers_no_delete_with_shareables
BEFORE DELETE ON artifact_containers
WHEN EXISTS (
  SELECT 1
  FROM shareables
  WHERE shareables.container_id = OLD.id
)
BEGIN
  SELECT RAISE(ABORT, 'artifact_containers with shareables cannot be deleted');
END;
