CREATE TABLE slack_workspaces (
  id                    TEXT PRIMARY KEY,
  team_id               TEXT NOT NULL UNIQUE,
  team_name             TEXT NOT NULL,
  bot_user_id           TEXT NOT NULL,
  bot_token             TEXT NOT NULL,
  installed_by_user_id  TEXT REFERENCES users(id) ON DELETE SET NULL,
  installed_at          TEXT NOT NULL
);

CREATE TABLE slack_user_links (
  id                    TEXT PRIMARY KEY,
  slack_team_id         TEXT NOT NULL REFERENCES slack_workspaces(team_id) ON DELETE CASCADE,
  slack_user_id         TEXT NOT NULL,
  artifactshare_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  linked_at             TEXT NOT NULL,
  UNIQUE (slack_team_id, slack_user_id)
);

CREATE INDEX slack_user_links_artifactshare_user_id
  ON slack_user_links(artifactshare_user_id);
