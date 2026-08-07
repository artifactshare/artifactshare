-- Migration: 0039_mcp_artifact_posts
-- Created: 2026-06-06
-- Description: Minimal record of artifacts posted through the MCP server. Powers
-- two things: idempotent resends (a host re-sending the same publish returns the
-- existing artifact instead of a duplicate) and an audit trail (which OAuth
-- client / user posted what, when) so an admin can later trace, e.g., an ex
-- member's posts. snake_case to match the app's own tables (not the better-auth
-- camelCase tables). Mirrors db/schema.sql; keep both in sync.

CREATE TABLE mcp_artifact_posts (
  id            TEXT PRIMARY KEY,
  shareable_id  TEXT NOT NULL REFERENCES shareables(id) ON DELETE CASCADE,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  -- OAuth client (the access token's azp); NULL for the dev-token bypass.
  client_id     TEXT,
  action        TEXT NOT NULL CHECK (action IN ('publish', 'update')),
  -- sha256 of the canonical request payload, for idempotent-resend lookup.
  content_hash  TEXT NOT NULL,
  created_at    TEXT NOT NULL
);

-- Idempotency lookup: most recent publish by this user with this content hash.
CREATE INDEX mcp_artifact_posts_idempotency
  ON mcp_artifact_posts(user_id, content_hash);

-- Audit / offboarding: a workspace's posts, optionally narrowed to one member.
CREATE INDEX mcp_artifact_posts_workspace
  ON mcp_artifact_posts(workspace_id, user_id, created_at);

-- Back the ON DELETE CASCADE so removing a shareable doesn't table-scan.
CREATE INDEX mcp_artifact_posts_shareable
  ON mcp_artifact_posts(shareable_id);
