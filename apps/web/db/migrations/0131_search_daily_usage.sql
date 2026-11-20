CREATE TABLE search_actor_daily_usage (
  actor_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  day TEXT NOT NULL,
  requests INTEGER NOT NULL CHECK (requests BETWEEN 1 AND 1000),
  PRIMARY KEY (actor_id, day)
);
CREATE INDEX search_actor_daily_usage_day ON search_actor_daily_usage(day);

CREATE TABLE search_workspace_daily_usage (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  day TEXT NOT NULL,
  requests INTEGER NOT NULL CHECK (requests > 0),
  PRIMARY KEY (workspace_id, day)
);
CREATE INDEX search_workspace_daily_usage_day ON search_workspace_daily_usage(day);
