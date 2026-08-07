-- Migration: 0043_artifact_keys
-- Created: 2026-06-10
-- Description: Stable-key index for CLI `publish --key`. One row maps
-- (owner, destination container, key) to the shareable it updates, so CI can
-- re-publish without storing artifact IDs. Rows cascade away with the
-- shareable; keys do not follow a shareable when it moves to another container.

CREATE TABLE artifact_keys (
  id             TEXT PRIMARY KEY,
  workspace_id   TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  owner_user_id  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  container_id   TEXT NOT NULL REFERENCES artifact_containers(id) ON DELETE CASCADE,
  stable_key     TEXT NOT NULL,
  shareable_id   TEXT NOT NULL REFERENCES shareables(id) ON DELETE CASCADE,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  UNIQUE (owner_user_id, container_id, stable_key)
);

-- Cascade cleanup and "which keys point here" lookups by shareable.
CREATE INDEX artifact_keys_shareable ON artifact_keys(shareable_id);
