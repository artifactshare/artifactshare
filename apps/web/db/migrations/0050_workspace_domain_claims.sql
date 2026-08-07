CREATE TABLE workspace_domain_claims (
  domain TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  source TEXT NOT NULL CHECK (source IN ('google_hd', 'microsoft_verified_domain')),
  provider_tenant_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX workspace_domain_claims_workspace_id
  ON workspace_domain_claims(workspace_id);

INSERT INTO workspace_domain_claims (
  domain, workspace_id, source, provider_tenant_id, created_at, updated_at
)
SELECT
  lower(hd),
  id,
  'google_hd',
  NULL,
  created_at,
  created_at
FROM workspaces
WHERE hd IS NOT NULL
  AND id = (
    SELECT candidate.id
    FROM workspaces AS candidate
    WHERE candidate.hd IS NOT NULL
      AND lower(candidate.hd) = lower(workspaces.hd)
    ORDER BY candidate.created_at, candidate.id
    LIMIT 1
  )
  AND lower(hd) NOT IN (
    'gmail.com',
    'googlemail.com',
    'outlook.com',
    'hotmail.com',
    'live.com',
    'msn.com',
    'icloud.com',
    'me.com',
    'mac.com',
    'yahoo.com',
    'ymail.com',
    'proton.me',
    'protonmail.com'
  );
