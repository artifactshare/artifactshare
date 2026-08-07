-- Migration: 0047_cli_refresh_credentials
-- Created: 2026-06-21
-- Description: CLI profile refresh credentials for renewing session tokens.
-- Mirrors db/schema.sql; keep both in sync.

CREATE TABLE cli_refresh_credentials (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash    TEXT NOT NULL UNIQUE,
  expires_at    TEXT NOT NULL,
  revoked_at    TEXT,
  created_at    TEXT NOT NULL,
  last_used_at  TEXT
);
CREATE INDEX cli_refresh_credentials_user_id ON cli_refresh_credentials(user_id);
