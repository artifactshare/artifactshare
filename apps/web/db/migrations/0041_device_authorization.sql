-- Migration: 0041_device_authorization
-- Created: 2026-06-10
-- Description: Better Auth device authorization table.
-- Mirrors db/schema.sql; keep both in sync.

CREATE TABLE deviceCode (
  id               TEXT PRIMARY KEY,
  deviceCode       TEXT NOT NULL UNIQUE,
  userCode         TEXT NOT NULL UNIQUE,
  userId           TEXT REFERENCES users(id) ON DELETE CASCADE,
  expiresAt        TEXT NOT NULL,
  status           TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'denied')),
  lastPolledAt     TEXT,
  pollingInterval  INTEGER,
  clientId         TEXT,
  scope            TEXT
);
CREATE INDEX deviceCode_userId ON deviceCode(userId);
