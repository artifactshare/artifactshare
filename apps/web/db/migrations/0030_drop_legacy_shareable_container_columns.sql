CREATE TABLE shareable_container_cleanup_assertions (
  must_be_empty TEXT NOT NULL
);

INSERT INTO shareable_container_cleanup_assertions (must_be_empty)
SELECT NULL
FROM shareables
WHERE container_id IS NULL
LIMIT 1;

DROP TABLE shareable_container_cleanup_assertions;

DROP INDEX shareables_project_created;

ALTER TABLE shareables DROP COLUMN container_type;
ALTER TABLE shareables DROP COLUMN project_id;

CREATE TRIGGER shareables_container_id_required_insert
BEFORE INSERT ON shareables
WHEN NEW.container_id IS NULL
BEGIN
  SELECT RAISE(ABORT, 'shareables.container_id is required');
END;

CREATE TRIGGER shareables_container_id_required_update
BEFORE UPDATE OF container_id ON shareables
WHEN NEW.container_id IS NULL
BEGIN
  SELECT RAISE(ABORT, 'shareables.container_id is required');
END;

DROP TABLE IF EXISTS project_grants;
DROP TABLE IF EXISTS projects;
