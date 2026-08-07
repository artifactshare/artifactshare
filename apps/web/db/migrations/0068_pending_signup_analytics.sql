-- Migration: 0068_pending_signup_analytics
-- Created: 2026-07-24
-- Description: One row per new user at signup, so the client can fire GA4
-- sign_up / workspace_created approximately-once via an atomic claim-before-send
-- lease (dataLayer.push returns no delivery ack, so exactly-once is not
-- guaranteed). workspace_created marks a self-serve new-workspace INSERT; it is
-- cleared to 0 when an OAuth user is moved into an existing domain-claimed
-- workspace. Mirrors db/schema.sql; keep both in sync.

CREATE TABLE pending_signup_analytics (
  user_id           TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  method            TEXT NOT NULL CHECK (method IN ('google', 'microsoft', 'email')),
  workspace_created INTEGER NOT NULL CHECK (workspace_created IN (0, 1)),
  created_at        TEXT NOT NULL,
  claimed_at        TEXT,
  tracked_at        TEXT
);
