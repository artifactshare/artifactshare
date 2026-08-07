-- Migration: 0042_access_request_source_cli
-- Created: 2026-06-10
-- Description: Allow 'cli' as an access_requests.source so the CLI
-- request-access command can record where the signup came from. SQLite cannot
-- alter a CHECK constraint in place, so rebuild the table.

CREATE TABLE access_requests_new (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  email         TEXT NOT NULL,
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  source        TEXT NOT NULL CHECK (source IN ('web', 'mcp', 'cli')),
  note          TEXT,
  status        TEXT NOT NULL DEFAULT 'requested'
                CHECK (status IN ('requested', 'contacted', 'granted', 'declined')),
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

INSERT INTO access_requests_new (
  id, user_id, email, workspace_id, source, note, status, created_at, updated_at
)
SELECT
  id, user_id, email, workspace_id, source, note, status, created_at, updated_at
FROM access_requests;

DROP TABLE access_requests;

ALTER TABLE access_requests_new RENAME TO access_requests;

CREATE INDEX access_requests_status ON access_requests(status, created_at);
