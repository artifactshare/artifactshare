CREATE TABLE container_slack_channels (
  container_id       TEXT PRIMARY KEY REFERENCES artifact_containers(id) ON DELETE CASCADE,
  slack_workspace_id TEXT NOT NULL REFERENCES slack_workspaces(id) ON DELETE CASCADE,
  channel_id         TEXT NOT NULL,
  channel_name       TEXT NOT NULL,
  created_by         TEXT REFERENCES users(id) ON DELETE SET NULL,
  updated_by         TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL
);
CREATE TRIGGER container_slack_channels_project_only_insert
BEFORE INSERT ON container_slack_channels
WHEN NOT EXISTS (SELECT 1 FROM artifact_containers WHERE id = NEW.container_id AND kind = 'project')
BEGIN SELECT RAISE(ABORT, 'container_slack_channels requires project container'); END;
CREATE TRIGGER container_slack_channels_project_only_update
BEFORE UPDATE OF container_id ON container_slack_channels
WHEN NOT EXISTS (SELECT 1 FROM artifact_containers WHERE id = NEW.container_id AND kind = 'project')
BEGIN SELECT RAISE(ABORT, 'container_slack_channels requires project container'); END;

CREATE TABLE slack_notification_outbox (
  id           TEXT PRIMARY KEY,
  container_id TEXT NOT NULL REFERENCES artifact_containers(id) ON DELETE CASCADE,
  shareable_id TEXT NOT NULL UNIQUE REFERENCES shareables(id) ON DELETE CASCADE,
  created_at   TEXT NOT NULL,
  claimed_at   TEXT,
  claim_token  TEXT
);
