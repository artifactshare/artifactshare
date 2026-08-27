CREATE TABLE workspace_migration_waits (
  id                   TEXT PRIMARY KEY,
  user_id              TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source_workspace_id  TEXT NOT NULL,
  target_workspace_id  TEXT NOT NULL,
  reason_codes         TEXT NOT NULL
                       CHECK (json_valid(reason_codes) AND json_type(reason_codes) = 'array'),
  generation           INTEGER NOT NULL DEFAULT 1 CHECK (generation > 0),
  first_detected_at    TEXT NOT NULL,
  last_detected_at     TEXT NOT NULL,
  resolved_at          TEXT,
  UNIQUE (user_id, target_workspace_id)
);
CREATE INDEX workspace_migration_waits_active
  ON workspace_migration_waits(resolved_at, last_detected_at DESC);
