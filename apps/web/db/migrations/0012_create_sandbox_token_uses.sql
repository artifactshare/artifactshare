CREATE TABLE sandbox_token_uses (
  jti         TEXT PRIMARY KEY,
  expires_at  TEXT NOT NULL
);
CREATE INDEX sandbox_token_uses_expires_at ON sandbox_token_uses(expires_at);
