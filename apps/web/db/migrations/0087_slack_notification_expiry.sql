CREATE TABLE container_slack_channels_tmp AS
SELECT * FROM container_slack_channels;

DROP TABLE container_slack_channels;
CREATE TABLE container_slack_channels (
  container_id       TEXT PRIMARY KEY REFERENCES artifact_containers(id) ON DELETE CASCADE,
  webhook_url        TEXT NOT NULL,
  channel_id         TEXT NOT NULL,
  channel_name       TEXT NOT NULL,
  slack_team_id      TEXT NOT NULL,
  slack_team_name    TEXT NOT NULL,
  configuration_url   TEXT,
  created_by         TEXT REFERENCES users(id) ON DELETE SET NULL,
  updated_by         TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL,
  last_error_at      TEXT,
  last_error_status  INTEGER,
  CHECK (
    (last_error_at IS NULL AND last_error_status IS NULL)
    OR (last_error_at IS NOT NULL AND last_error_status = 404)
  )
);
INSERT INTO container_slack_channels (
  container_id, webhook_url, channel_id, channel_name, slack_team_id,
  slack_team_name, configuration_url, created_by, updated_by, created_at,
  updated_at, last_error_at, last_error_status
)
SELECT
  container_id, webhook_url, channel_id, channel_name, slack_team_id,
  slack_team_name, configuration_url, created_by, updated_by, created_at,
  updated_at, NULL, NULL
FROM container_slack_channels_tmp;

CREATE TRIGGER container_slack_channels_project_only_insert
BEFORE INSERT ON container_slack_channels
WHEN NOT EXISTS (SELECT 1 FROM artifact_containers WHERE id = NEW.container_id AND kind = 'project')
BEGIN SELECT RAISE(ABORT, 'container_slack_channels requires project container'); END;
CREATE TRIGGER container_slack_channels_project_only_update
BEFORE UPDATE OF container_id ON container_slack_channels
WHEN NOT EXISTS (SELECT 1 FROM artifact_containers WHERE id = NEW.container_id AND kind = 'project')
BEGIN SELECT RAISE(ABORT, 'container_slack_channels requires project container'); END;

CREATE TABLE _migration_0087_guard (ok INTEGER NOT NULL CHECK (ok = 1));
INSERT INTO _migration_0087_guard (ok)
SELECT CASE
  WHEN (SELECT COUNT(*) FROM container_slack_channels)
       = (SELECT COUNT(*) FROM container_slack_channels_tmp)
  THEN 1 ELSE 0 END;
DROP TABLE _migration_0087_guard;
DROP TABLE container_slack_channels_tmp;
