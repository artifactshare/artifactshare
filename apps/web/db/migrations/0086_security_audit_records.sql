CREATE TABLE security_audit_records (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  actor_type   TEXT NOT NULL,
  actor_id     TEXT NOT NULL,
  client_type  TEXT NOT NULL,
  client_id    TEXT,
  subject_type TEXT NOT NULL,
  subject_id   TEXT NOT NULL,
  action       TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  CHECK (client_type <> 'oauth_client' OR client_id IS NOT NULL)
);

CREATE INDEX security_audit_workspace_created
  ON security_audit_records(workspace_id, created_at DESC);
CREATE INDEX security_audit_subject_created
  ON security_audit_records(subject_type, subject_id, created_at DESC);
CREATE INDEX security_audit_actor_created
  ON security_audit_records(actor_type, actor_id, created_at DESC);
CREATE INDEX security_audit_client_created
  ON security_audit_records(client_type, client_id, created_at DESC);
CREATE INDEX security_audit_cleanup
  ON security_audit_records(created_at, id);
