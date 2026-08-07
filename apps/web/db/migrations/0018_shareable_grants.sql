CREATE TABLE shareable_grants (
  shareable_id  TEXT NOT NULL REFERENCES shareables(id) ON DELETE CASCADE,
  granted_email TEXT NOT NULL,
  granted_at    TEXT NOT NULL,
  granted_by    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (shareable_id, granted_email)
);

CREATE INDEX idx_shareable_grants_email ON shareable_grants(granted_email);

UPDATE users SET email = lower(email) WHERE email != lower(email);
