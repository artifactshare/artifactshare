-- Migration: 0046_shareable_delete_events
-- Created: 2026-06-15
-- Description: Audit record of project artifact deletions (who deleted what, when).
-- No FK to shareables (the row is physically deleted in the same batch); deleted_by
-- is ON DELETE SET NULL so the record survives the deleter's account removal.
-- project_container_id / workspace_id / owner_user_id are stored as values (no FK)
-- so the record outlives later container / workspace / poster removal.
-- Mirrors db/schema.sql; keep both in sync.

CREATE TABLE shareable_delete_events (
  id                    TEXT PRIMARY KEY,
  project_container_id  TEXT NOT NULL,
  workspace_id          TEXT NOT NULL,
  shareable_id          TEXT NOT NULL,
  shareable_name        TEXT NOT NULL,
  owner_user_id         TEXT NOT NULL,
  deleted_by            TEXT REFERENCES users(id) ON DELETE SET NULL,
  deleted_at            TEXT NOT NULL
);
