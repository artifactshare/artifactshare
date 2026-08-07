-- Migration: 0044_api_tokens
-- Created: 2026-06-11
-- Description: Long-lived API tokens for CI and non-interactive CLI auth.
-- Mirrors db/schema.sql; keep both in sync.

CREATE TABLE api_tokens (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  token_hash   TEXT NOT NULL UNIQUE,
  created_at   TEXT NOT NULL,
  last_used_at TEXT,
  revoked_at   TEXT
);
CREATE INDEX api_tokens_user_id ON api_tokens(user_id);
