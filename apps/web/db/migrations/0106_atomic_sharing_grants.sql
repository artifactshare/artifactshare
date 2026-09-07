CREATE TABLE link_publication_attempts (
  workspace_id   TEXT NOT NULL
                 REFERENCES workspaces(id) ON DELETE CASCADE,
  shareable_id   TEXT NOT NULL,
  published_at   TEXT NOT NULL,
  window_start   TEXT NOT NULL,
  daily_limit    INTEGER NOT NULL CHECK (daily_limit >= 0),
  limit_applies  INTEGER NOT NULL CHECK (limit_applies IN (0, 1)),
  consumed       INTEGER NOT NULL DEFAULT 0 CHECK (consumed IN (0, 1)),
  requested_grants_present INTEGER NOT NULL DEFAULT 1
    CONSTRAINT link_publication_all_requested_grants_present
    CHECK (requested_grants_present = 1),
  PRIMARY KEY (workspace_id, shareable_id)
);

CREATE TRIGGER link_publication_attempt_must_be_consumed
BEFORE DELETE ON link_publication_attempts
WHEN OLD.consumed <> 1
BEGIN
  SELECT RAISE(ABORT, 'link publication mutation missing');
END;
