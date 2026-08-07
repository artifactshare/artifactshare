CREATE TABLE project_pins (
  container_id      TEXT NOT NULL REFERENCES artifact_containers(id) ON DELETE CASCADE,
  shareable_id      TEXT NOT NULL REFERENCES shareables(id) ON DELETE CASCADE,
  pinned_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at        TEXT NOT NULL,
  PRIMARY KEY (container_id, shareable_id)
);
CREATE INDEX project_pins_shareable ON project_pins(shareable_id);
