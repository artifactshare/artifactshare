ALTER TABLE shareables ADD COLUMN assigned_publisher_client_id TEXT REFERENCES publisher_clients(id) ON DELETE RESTRICT;
CREATE INDEX shareables_assigned_publisher_client_id ON shareables(assigned_publisher_client_id);
