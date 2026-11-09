CREATE TABLE bot_destination_projects (
  family_id TEXT NOT NULL REFERENCES cli_family_authorities(family_id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES artifact_containers(id) ON DELETE RESTRICT,
  project_name_snapshot TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (family_id, project_id)
);
CREATE INDEX bot_destination_projects_project_id ON bot_destination_projects(project_id);
CREATE TRIGGER bot_destination_projects_validate_insert
BEFORE INSERT ON bot_destination_projects
WHEN NOT EXISTS (
  SELECT 1 FROM cli_family_authorities f
  JOIN users u ON u.id = f.user_id
  JOIN artifact_containers p ON p.id = NEW.project_id
  WHERE f.family_id = NEW.family_id AND f.preset = 'agent'
    AND u.kind = 'bot' AND f.bridge_authority_id IS NULL
    AND NOT EXISTS (SELECT 1 FROM bridge_authorities b WHERE b.bot_user_id = u.id)
    AND p.kind = 'project' AND p.workspace_id = f.workspace_id
    AND u.workspace_id = f.workspace_id
)
BEGIN
  SELECT RAISE(ABORT, 'invalid bot destination');
END;

INSERT INTO bot_destination_projects (family_id, project_id, project_name_snapshot, created_at)
SELECT f.family_id, f.project_id, f.project_name_snapshot, f.created_at
FROM cli_family_authorities f JOIN users u ON u.id = f.user_id
WHERE u.kind = 'bot' AND f.preset = 'agent' AND f.project_id IS NOT NULL
  AND f.bridge_authority_id IS NULL
  AND NOT EXISTS (SELECT 1 FROM bridge_authorities b WHERE b.bot_user_id = u.id);
