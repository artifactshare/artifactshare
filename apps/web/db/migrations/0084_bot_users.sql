-- Migration: 0084_bot_users
-- Created: 2026-08-13
-- Description: Add a user kind ('human' | 'bot') and bot lifecycle columns so
-- workspaces can register non-human members. Bots are stopped (soft) via
-- bot_stopped_at; active bot display names are unique per workspace so a
-- stopped bot's name can be reused. Cross-table invariants that SQLite CHECK
-- cannot express are enforced with triggers:
--   * users.kind is immutable after creation (both directions),
--   * api_tokens can never belong to a bot user,
--   * cli_family_authorities rows for bot users must use the agent preset.
-- The migration asserts that no existing user row already uses the reserved
-- RFC 2606 `.invalid` email domain that generated bot addresses occupy.

ALTER TABLE users ADD COLUMN kind TEXT NOT NULL DEFAULT 'human'
  CHECK (kind IN ('human', 'bot'));
ALTER TABLE users ADD COLUMN bot_stopped_at TEXT;

-- Active bots only: a stopped bot releases its name for reuse.
CREATE UNIQUE INDEX users_active_bot_name
  ON users(workspace_id, name)
  WHERE kind = 'bot' AND bot_stopped_at IS NULL;

-- Reserved-domain assertion: bot emails live under the unobtainable
-- `.invalid` TLD. A pre-existing row there could impersonate a future bot, so
-- the migration refuses to apply. A violation inserts 0 into a CHECK (ok = 1)
-- column and aborts the migration.
CREATE TABLE _migration_0084_guard (ok INTEGER NOT NULL CHECK (ok = 1));
INSERT INTO _migration_0084_guard (ok)
SELECT CASE
  WHEN (
    SELECT COUNT(*) FROM users
    WHERE lower(substr(email, instr(email, '@') + 1)) LIKE '%.invalid'
       OR lower(substr(email, instr(email, '@') + 1)) = 'invalid'
  ) = 0 THEN 1 ELSE 0 END;
DROP TABLE _migration_0084_guard;

-- kind is fixed at creation. Flipping a credentialed human to 'bot' (or a bot
-- to 'human') via direct SQL would fabricate states the application never
-- creates, so both directions are rejected.
CREATE TRIGGER users_kind_immutable
BEFORE UPDATE OF kind ON users
WHEN OLD.kind <> NEW.kind
BEGIN
  SELECT RAISE(ABORT, 'users.kind is immutable');
END;

-- API tokens bypass the CLI authority resolver in the auth middleware, so the
-- database is the only guard that keeps bots off the unrestricted API-token
-- path.
CREATE TRIGGER api_tokens_reject_bot_insert
BEFORE INSERT ON api_tokens
WHEN EXISTS (SELECT 1 FROM users WHERE id = NEW.user_id AND kind = 'bot')
BEGIN
  SELECT RAISE(ABORT, 'api tokens are not available to bot users');
END;
CREATE TRIGGER api_tokens_reject_bot_update
BEFORE UPDATE ON api_tokens
WHEN EXISTS (SELECT 1 FROM users WHERE id = NEW.user_id AND kind = 'bot')
BEGIN
  SELECT RAISE(ABORT, 'api tokens are not available to bot users');
END;

-- Bots only ever hold restricted agent-preset credential families.
CREATE TRIGGER cli_family_authorities_bot_agent_only_insert
BEFORE INSERT ON cli_family_authorities
WHEN NEW.preset <> 'agent'
  AND EXISTS (SELECT 1 FROM users WHERE id = NEW.user_id AND kind = 'bot')
BEGIN
  SELECT RAISE(ABORT, 'bot users only allow agent preset authorities');
END;
CREATE TRIGGER cli_family_authorities_bot_agent_only_update
BEFORE UPDATE ON cli_family_authorities
WHEN NEW.preset <> 'agent'
  AND EXISTS (SELECT 1 FROM users WHERE id = NEW.user_id AND kind = 'bot')
BEGIN
  SELECT RAISE(ABORT, 'bot users only allow agent preset authorities');
END;
