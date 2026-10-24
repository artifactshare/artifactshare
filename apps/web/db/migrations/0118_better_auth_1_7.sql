-- Better Auth 1.7.12: core accountSubject and OAuth provider schema.
-- Keep the established physical names: accounts is snake_case; plugin tables
-- use camelCase. Existing deviceCode uniqueness already satisfies 1.7.12.
-- Nullable additions use plugin defaults when written through the adapter.
ALTER TABLE jwks ADD COLUMN alg TEXT;
ALTER TABLE jwks ADD COLUMN crv TEXT;
ALTER TABLE oauthClient ADD COLUMN clientDiscoveryId TEXT;
ALTER TABLE oauthClient ADD COLUMN clientCredentialsScopes TEXT;
ALTER TABLE oauthClient ADD COLUMN backchannelLogoutUri TEXT;
ALTER TABLE oauthClient ADD COLUMN backchannelLogoutSessionRequired INTEGER;
ALTER TABLE oauthClient ADD COLUMN applicationType TEXT;
ALTER TABLE oauthClient ADD COLUMN jwks TEXT;
ALTER TABLE oauthClient ADD COLUMN jwksUri TEXT;
ALTER TABLE oauthClient ADD COLUMN dpopBoundAccessTokens INTEGER;
ALTER TABLE oauthRefreshToken ADD COLUMN authorizationCodeId TEXT;
ALTER TABLE oauthRefreshToken ADD COLUMN resources TEXT;
ALTER TABLE oauthRefreshToken ADD COLUMN requestedUserInfoClaims TEXT;
ALTER TABLE oauthRefreshToken ADD COLUMN rotatedAt TEXT;
ALTER TABLE oauthRefreshToken ADD COLUMN rotationReplayResponse TEXT;
ALTER TABLE oauthRefreshToken ADD COLUMN rotationReplayExpiresAt TEXT;
ALTER TABLE oauthRefreshToken ADD COLUMN confirmation TEXT;
ALTER TABLE oauthAccessToken ADD COLUMN authorizationCodeId TEXT;
ALTER TABLE oauthAccessToken ADD COLUMN resources TEXT;
ALTER TABLE oauthAccessToken ADD COLUMN requestedUserInfoClaims TEXT;
ALTER TABLE oauthAccessToken ADD COLUMN revoked TEXT;
ALTER TABLE oauthAccessToken ADD COLUMN confirmation TEXT;
ALTER TABLE oauthConsent ADD COLUMN resources TEXT;
ALTER TABLE oauthConsent ADD COLUMN requestedUserInfoClaims TEXT;

CREATE INDEX oauthRefreshToken_authorizationCodeId ON oauthRefreshToken(authorizationCodeId);
CREATE INDEX oauthAccessToken_authorizationCodeId ON oauthAccessToken(authorizationCodeId);

CREATE TABLE oauthResource (
  id TEXT PRIMARY KEY,
  identifier TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  accessTokenTtl INTEGER,
  refreshTokenTtl INTEGER,
  signingAlgorithm TEXT,
  signingKeyId TEXT,
  allowedScopes TEXT,
  customClaims TEXT,
  dpopBoundAccessTokensRequired INTEGER,
  disabled INTEGER,
  createdAt TEXT,
  updatedAt TEXT,
  policyVersion INTEGER,
  metadata TEXT
);

CREATE TABLE oauthClientResource (
  id TEXT PRIMARY KEY,
  clientId TEXT NOT NULL REFERENCES oauthClient(clientId) ON DELETE CASCADE,
  resourceId TEXT NOT NULL REFERENCES oauthResource(identifier) ON DELETE CASCADE,
  metadata TEXT,
  createdAt TEXT,
  UNIQUE (clientId, resourceId)
);
CREATE INDEX oauthClientResource_clientId ON oauthClientResource(clientId);
CREATE INDEX oauthClientResource_resourceId ON oauthClientResource(resourceId);

CREATE TABLE oauthClientAssertion (
  id TEXT PRIMARY KEY,
  expiresAt TEXT NOT NULL
);

-- 1.7.12 resolves Microsoft accountSubject to oid. It validates iss against
-- tid in the ID token, but does not persist an issuer column in accounts.
-- Preserve id_token (including tid/iss), user_id and the account row id.
UPDATE accounts
SET account_id = substr(account_id, 38)
WHERE provider_id = 'microsoft'
  AND length(account_id) = 73 AND substr(account_id, 37, 1) = ':';

-- The deployment's sole MCP resource. Seed before linking existing clients;
-- the runtime resources option uses insertOnly and leaves this row intact.
INSERT INTO oauthResource (id, identifier, name)
VALUES ('mcp', 'https://artifactshare.com/mcp', 'Artifact Share MCP');
INSERT INTO oauthClientResource (id, clientId, resourceId)
SELECT 'mcp:' || id, clientId, 'https://artifactshare.com/mcp' FROM oauthClient;
UPDATE oauthRefreshToken
SET resources = '["https://artifactshare.com/mcp"]'
WHERE revoked IS NULL;
UPDATE oauthAccessToken
SET resources = '["https://artifactshare.com/mcp"]';
UPDATE oauthConsent
SET resources = '["https://artifactshare.com/mcp"]';

-- Public clients used the public flag in 1.6; 1.7 uses the auth method alone.
UPDATE oauthClient SET tokenEndpointAuthMethod = 'none'
WHERE public = 1 AND tokenEndpointAuthMethod IS NULL;
