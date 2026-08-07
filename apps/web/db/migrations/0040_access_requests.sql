-- Migration: 0040_access_requests
-- Created: 2026-06-07
-- Description: Closed-beta waitlist. One row per user records that they asked
-- for upload access (from the web or an MCP host) so the operator can reach out.
-- The upload gate stays on Cloudflare Flagship; `status` is an operator note,
-- not an authorization signal.

CREATE TABLE access_requests (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  email         TEXT NOT NULL,
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  source        TEXT NOT NULL CHECK (source IN ('web', 'mcp')),
  note          TEXT,
  status        TEXT NOT NULL DEFAULT 'requested'
                CHECK (status IN ('requested', 'contacted', 'granted', 'declined')),
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

-- Operator listing orders by recency within a status.
CREATE INDEX access_requests_status ON access_requests(status, created_at);
