-- Migration: 0085_cli_rotation_replay_cleanup
-- Created: 2026-08-16
-- Description: Keep bounded rotation replay cleanup indexed after rollout.
-- Mirrors db/schema.sql; keep both in sync.
-- Refresh-session linkage shipped on 2026-08-09. Its seven-day session TTL
-- elapsed before this rollout cleanup removed the pre-link revoke fallback.

CREATE INDEX cli_refresh_credentials_rotation_retry_until
  ON cli_refresh_credentials(rotation_retry_until)
  WHERE rotation_request_hash IS NOT NULL
    AND revoked_at IS NOT NULL;
