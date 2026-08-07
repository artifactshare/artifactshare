CREATE TABLE project_grants (
  id             TEXT PRIMARY KEY,
  project_id     TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  email          TEXT NOT NULL,
  role           TEXT NOT NULL DEFAULT 'viewer' CHECK (role IN ('viewer')),
  display_name   TEXT,
  created_by_id  TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  UNIQUE (project_id, email)
);

CREATE INDEX project_grants_email ON project_grants(email);

CREATE TABLE shareable_grant_origins (
  shareable_id       TEXT NOT NULL,
  granted_email      TEXT NOT NULL,
  origin_type        TEXT NOT NULL CHECK (origin_type IN ('manual', 'project')),
  project_grant_id   TEXT REFERENCES project_grants(id) ON DELETE CASCADE,
  created_at         TEXT NOT NULL,
  created_by         TEXT REFERENCES users(id) ON DELETE SET NULL,
  FOREIGN KEY (shareable_id, granted_email)
    REFERENCES shareable_grants(shareable_id, granted_email)
    ON DELETE CASCADE,
  CHECK (
    (origin_type = 'manual' AND project_grant_id IS NULL) OR
    (origin_type = 'project' AND project_grant_id IS NOT NULL)
  )
);

CREATE UNIQUE INDEX shareable_grant_origins_manual_unique
  ON shareable_grant_origins(shareable_id, granted_email)
  WHERE origin_type = 'manual';

CREATE UNIQUE INDEX shareable_grant_origins_project_unique
  ON shareable_grant_origins(shareable_id, granted_email, project_grant_id)
  WHERE origin_type = 'project';

CREATE INDEX shareable_grant_origins_project_grant
  ON shareable_grant_origins(project_grant_id);

UPDATE shareable_grants
SET granted_email = lower(granted_email)
WHERE granted_email != lower(granted_email);

INSERT OR IGNORE INTO shareable_grant_origins (
  shareable_id,
  granted_email,
  origin_type,
  project_grant_id,
  created_at,
  created_by
)
SELECT
  shareable_id,
  lower(granted_email),
  'manual',
  NULL,
  granted_at,
  granted_by
FROM shareable_grants;

CREATE TABLE shareable_project_grant_exclusions (
  shareable_id       TEXT NOT NULL REFERENCES shareables(id) ON DELETE CASCADE,
  project_grant_id   TEXT NOT NULL REFERENCES project_grants(id) ON DELETE CASCADE,
  created_by_id      TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at         TEXT NOT NULL,
  PRIMARY KEY (shareable_id, project_grant_id)
);

CREATE INDEX shareable_project_grant_exclusions_project_grant
  ON shareable_project_grant_exclusions(project_grant_id);
