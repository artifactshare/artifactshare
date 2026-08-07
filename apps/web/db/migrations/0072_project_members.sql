CREATE TABLE project_members (
  container_id TEXT NOT NULL REFERENCES artifact_containers(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  joined_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  PRIMARY KEY (container_id, user_id)
);
CREATE INDEX project_members_user ON project_members(user_id);
CREATE TRIGGER project_members_project_only_insert
BEFORE INSERT ON project_members
WHEN NOT EXISTS (SELECT 1 FROM artifact_containers WHERE id = NEW.container_id AND kind = 'project')
BEGIN SELECT RAISE(ABORT, 'project_members requires project container'); END;
CREATE TRIGGER project_members_project_only_update
BEFORE UPDATE OF container_id ON project_members
WHEN NOT EXISTS (SELECT 1 FROM artifact_containers WHERE id = NEW.container_id AND kind = 'project')
BEGIN SELECT RAISE(ABORT, 'project_members requires project container'); END;
