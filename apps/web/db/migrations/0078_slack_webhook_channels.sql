DELETE FROM slack_notification_outbox;
DROP TABLE container_slack_channels;
CREATE TABLE container_slack_channels (
  container_id TEXT PRIMARY KEY REFERENCES artifact_containers(id) ON DELETE CASCADE,
  webhook_url TEXT NOT NULL, channel_id TEXT NOT NULL, channel_name TEXT NOT NULL,
  slack_team_id TEXT NOT NULL, slack_team_name TEXT NOT NULL, configuration_url TEXT,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  updated_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TRIGGER container_slack_channels_project_only_insert
BEFORE INSERT ON container_slack_channels
WHEN NOT EXISTS (SELECT 1 FROM artifact_containers WHERE id = NEW.container_id AND kind = 'project')
BEGIN SELECT RAISE(ABORT, 'container_slack_channels requires project container'); END;
CREATE TRIGGER container_slack_channels_project_only_update
BEFORE UPDATE OF container_id ON container_slack_channels
WHEN NOT EXISTS (SELECT 1 FROM artifact_containers WHERE id = NEW.container_id AND kind = 'project')
BEGIN SELECT RAISE(ABORT, 'container_slack_channels requires project container'); END;
CREATE TABLE slack_notify_nonces (nonce TEXT PRIMARY KEY, created_at TEXT NOT NULL);
