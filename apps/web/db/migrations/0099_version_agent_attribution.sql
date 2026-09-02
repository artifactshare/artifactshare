ALTER TABLE versions
  ADD COLUMN created_by_agent_profile_id TEXT REFERENCES agent_profiles(id) ON DELETE RESTRICT;

CREATE INDEX versions_created_by_agent_profile_id
  ON versions(created_by_agent_profile_id);
