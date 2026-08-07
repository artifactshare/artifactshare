-- Migration: 0001_initial
-- Created: 2026-05-10
-- Description: Initial schema. Creates workspaces, users, accounts,
-- sessions, verifications, artifacts, views with their indexes.
-- Mirrors db/schema.sql; keep both in sync.

PRAGMA foreign_keys = ON;

CREATE TABLE workspaces (
  id          TEXT PRIMARY KEY,
  hd          TEXT UNIQUE,
  name        TEXT NOT NULL,
  created_at  TEXT NOT NULL
);

CREATE TABLE users (
  id              TEXT PRIMARY KEY,
  email           TEXT NOT NULL UNIQUE,
  email_verified  INTEGER NOT NULL DEFAULT 0,
  name            TEXT,
  image           TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  workspace_id    TEXT NOT NULL REFERENCES workspaces(id),
  google_sub      TEXT NOT NULL UNIQUE
);
CREATE INDEX users_workspace_id ON users(workspace_id);

CREATE TABLE accounts (
  id                        TEXT PRIMARY KEY,
  user_id                   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider_id               TEXT NOT NULL,
  account_id                TEXT NOT NULL,
  access_token              TEXT,
  access_token_expires_at   TEXT,
  refresh_token             TEXT,
  refresh_token_expires_at  TEXT,
  id_token                  TEXT,
  scope                     TEXT,
  password                  TEXT,
  created_at                TEXT NOT NULL,
  updated_at                TEXT NOT NULL,
  UNIQUE (provider_id, account_id)
);
CREATE INDEX accounts_user_id ON accounts(user_id);

CREATE TABLE sessions (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token       TEXT NOT NULL UNIQUE,
  expires_at  TEXT NOT NULL,
  ip_address  TEXT,
  user_agent  TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
CREATE INDEX sessions_user_id ON sessions(user_id);

CREATE TABLE verifications (
  id          TEXT PRIMARY KEY,
  identifier  TEXT NOT NULL,
  value       TEXT NOT NULL,
  expires_at  TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
CREATE INDEX verifications_identifier ON verifications(identifier);

CREATE TABLE artifacts (
  id                   TEXT PRIMARY KEY,
  workspace_id         TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  drive_file_id        TEXT NOT NULL,
  drive_file_name      TEXT NOT NULL,
  drive_owner_email    TEXT,
  drive_modified_time  TEXT,
  registered_by_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at           TEXT NOT NULL,
  last_accessed_at     TEXT,
  UNIQUE (workspace_id, drive_file_id)
);
CREATE INDEX artifacts_workspace_owner_created
  ON artifacts(workspace_id, registered_by_id, created_at DESC);

CREATE TABLE views (
  id              TEXT PRIMARY KEY,
  artifact_id     TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
  viewer_user_id  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  viewed_at       TEXT NOT NULL,
  user_agent_hash TEXT
);
CREATE INDEX views_artifact_viewer_time
  ON views(artifact_id, viewer_user_id, viewed_at DESC);
CREATE INDEX views_viewer_time
  ON views(viewer_user_id, viewed_at DESC);
