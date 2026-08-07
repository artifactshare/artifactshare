-- Migration: 0037_oauth_provider
-- Created: 2026-06-06
-- Description: OAuth 2.1 authorization server tables
-- (@better-auth/oauth-provider) plus the JWT signing keys table (better-auth
-- jwt plugin). Column names follow better-auth's default camelCase so the
-- adapter's generated SQL matches without a field mapping.
-- Mirrors db/schema.sql; keep both in sync.

CREATE TABLE jwks (
  id          TEXT PRIMARY KEY,
  publicKey   TEXT NOT NULL,
  privateKey  TEXT NOT NULL,
  createdAt   TEXT NOT NULL,
  expiresAt   TEXT
);

CREATE TABLE oauthClient (
  id                       TEXT PRIMARY KEY,
  clientId                 TEXT NOT NULL UNIQUE,
  clientSecret             TEXT,
  disabled                 INTEGER,
  skipConsent              INTEGER,
  enableEndSession         INTEGER,
  subjectType              TEXT,
  scopes                   TEXT,
  userId                   TEXT REFERENCES users(id) ON DELETE CASCADE,
  createdAt                TEXT,
  updatedAt                TEXT,
  name                     TEXT,
  uri                      TEXT,
  icon                     TEXT,
  contacts                 TEXT,
  tos                      TEXT,
  policy                   TEXT,
  softwareId               TEXT,
  softwareVersion          TEXT,
  softwareStatement        TEXT,
  redirectUris             TEXT NOT NULL,
  postLogoutRedirectUris   TEXT,
  tokenEndpointAuthMethod  TEXT,
  grantTypes               TEXT,
  responseTypes            TEXT,
  public                   INTEGER,
  type                     TEXT,
  requirePKCE              INTEGER,
  referenceId              TEXT,
  metadata                 TEXT
);
CREATE INDEX oauthClient_userId ON oauthClient(userId);

CREATE TABLE oauthRefreshToken (
  id           TEXT PRIMARY KEY,
  token        TEXT NOT NULL UNIQUE,
  clientId     TEXT NOT NULL REFERENCES oauthClient(clientId) ON DELETE CASCADE,
  sessionId    TEXT REFERENCES sessions(id) ON DELETE SET NULL,
  userId       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  referenceId  TEXT,
  expiresAt    TEXT,
  createdAt    TEXT,
  revoked      TEXT,
  authTime     TEXT,
  scopes       TEXT NOT NULL
);
CREATE INDEX oauthRefreshToken_clientId ON oauthRefreshToken(clientId);
CREATE INDEX oauthRefreshToken_sessionId ON oauthRefreshToken(sessionId);
CREATE INDEX oauthRefreshToken_userId ON oauthRefreshToken(userId);

CREATE TABLE oauthAccessToken (
  id           TEXT PRIMARY KEY,
  token        TEXT UNIQUE,
  clientId     TEXT NOT NULL REFERENCES oauthClient(clientId) ON DELETE CASCADE,
  sessionId    TEXT REFERENCES sessions(id) ON DELETE SET NULL,
  userId       TEXT REFERENCES users(id) ON DELETE CASCADE,
  referenceId  TEXT,
  refreshId    TEXT REFERENCES oauthRefreshToken(id) ON DELETE SET NULL,
  expiresAt    TEXT,
  createdAt    TEXT,
  scopes       TEXT NOT NULL
);
CREATE INDEX oauthAccessToken_clientId ON oauthAccessToken(clientId);
CREATE INDEX oauthAccessToken_sessionId ON oauthAccessToken(sessionId);
CREATE INDEX oauthAccessToken_userId ON oauthAccessToken(userId);
CREATE INDEX oauthAccessToken_refreshId ON oauthAccessToken(refreshId);

CREATE TABLE oauthConsent (
  id           TEXT PRIMARY KEY,
  clientId     TEXT NOT NULL REFERENCES oauthClient(clientId) ON DELETE CASCADE,
  userId       TEXT REFERENCES users(id) ON DELETE CASCADE,
  referenceId  TEXT,
  scopes       TEXT NOT NULL,
  createdAt    TEXT,
  updatedAt    TEXT
);
CREATE INDEX oauthConsent_clientId ON oauthConsent(clientId);
CREATE INDEX oauthConsent_userId ON oauthConsent(userId);
