ALTER TABLE shareables ADD COLUMN retain_versions INTEGER CHECK (retain_versions IS NULL OR (typeof(retain_versions) = 'integer' AND retain_versions >= 1));
ALTER TABLE shareables ADD COLUMN version_sequence INTEGER NOT NULL DEFAULT 0;
ALTER TABLE versions ADD COLUMN number INTEGER;

WITH ranked AS (
  SELECT id, ROW_NUMBER() OVER (PARTITION BY shareable_id ORDER BY created_at, id) AS ordinal
  FROM versions WHERE status = 'published' AND published_at IS NOT NULL
)
UPDATE versions SET number = (SELECT ordinal FROM ranked WHERE ranked.id = versions.id);
UPDATE shareables SET version_sequence = COALESCE((SELECT MAX(number) FROM versions WHERE shareable_id = shareables.id), 0);

CREATE TRIGGER versions_number_insert AFTER INSERT ON versions
WHEN NEW.status = 'published' AND NEW.published_at IS NOT NULL
BEGIN
  UPDATE shareables SET version_sequence = version_sequence + 1 WHERE id = NEW.shareable_id;
  UPDATE versions SET number = (SELECT version_sequence FROM shareables WHERE id = NEW.shareable_id) WHERE id = NEW.id;
END;

CREATE TRIGGER versions_number_publish AFTER UPDATE OF status, published_at ON versions
WHEN NEW.status = 'published' AND NEW.published_at IS NOT NULL AND OLD.number IS NULL
BEGIN
  UPDATE shareables SET version_sequence = version_sequence + 1 WHERE id = NEW.shareable_id;
  UPDATE versions SET number = (SELECT version_sequence FROM shareables WHERE id = NEW.shareable_id) WHERE id = NEW.id;
END;

CREATE INDEX versions_shareable_number ON versions(shareable_id, number DESC);
CREATE INDEX shareables_current_version_id ON shareables(current_version_id);
