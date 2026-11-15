-- Mixed-case legacy email grants must remain discoverable through indexed lookup.
CREATE INDEX shareable_grants_lower_email_shareable
  ON shareable_grants(lower(granted_email), shareable_id);
CREATE INDEX project_share_defaults_lower_email_container
  ON project_share_defaults(lower(email), project_container_id);
