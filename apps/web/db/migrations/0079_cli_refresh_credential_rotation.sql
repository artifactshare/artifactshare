-- Migration: 0079_cli_refresh_credential_rotation
-- Created: 2026-08-09
-- Description: Add refresh-credential families and bounded idempotent rotation.
-- Mirrors db/schema.sql; keep both in sync.

ALTER TABLE cli_refresh_credentials ADD COLUMN family_id TEXT;
ALTER TABLE cli_refresh_credentials ADD COLUMN replaced_by_id TEXT;
ALTER TABLE cli_refresh_credentials ADD COLUMN rotation_request_hash TEXT;
ALTER TABLE cli_refresh_credentials ADD COLUMN rotation_retry_until TEXT;
ALTER TABLE cli_refresh_credentials ADD COLUMN rotation_session_id TEXT;

UPDATE cli_refresh_credentials SET family_id = id WHERE family_id IS NULL;

CREATE INDEX cli_refresh_credentials_family_id
  ON cli_refresh_credentials(family_id);
CREATE TABLE cli_refresh_sessions (
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  credential_id TEXT NOT NULL REFERENCES cli_refresh_credentials(id) ON DELETE CASCADE,
  family_id TEXT NOT NULL,
  PRIMARY KEY (session_id, family_id)
);

CREATE INDEX cli_refresh_sessions_family_id
  ON cli_refresh_sessions(family_id);
