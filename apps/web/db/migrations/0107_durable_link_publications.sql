CREATE TABLE link_publications (
  workspace_id        TEXT NOT NULL
                      REFERENCES workspaces(id) ON DELETE CASCADE,
  shareable_id        TEXT NOT NULL,
  latest_published_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, shareable_id)
);

CREATE INDEX link_publications_workspace_published
  ON link_publications(workspace_id, latest_published_at DESC, shareable_id);

CREATE INDEX link_publications_shareable_published
  ON link_publications(shareable_id, latest_published_at DESC);

WITH migration_clock(window_start) AS (
  VALUES (strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-24 hours'))
),
known_publications AS (
  SELECT workspace_id, shareable_id, created_at AS published_at
  FROM events
  WHERE type = 'visibility_changed'
    AND json_extract(payload, '$.to') = 'link'

  UNION ALL

  SELECT workspace_id, id AS shareable_id, created_at AS published_at
  FROM shareables
  WHERE visibility = 'link'
)
INSERT INTO link_publications (
  workspace_id, shareable_id, latest_published_at
)
SELECT workspace_id, shareable_id, MAX(published_at)
FROM known_publications
GROUP BY workspace_id, shareable_id
HAVING MAX(published_at) > (
  SELECT window_start FROM migration_clock
);

CREATE TRIGGER link_publication_active_id_guard
BEFORE INSERT ON shareables
WHEN EXISTS (
  SELECT 1
  FROM link_publications AS publication
  WHERE publication.shareable_id = NEW.id
    AND publication.latest_published_at > strftime(
      '%Y-%m-%dT%H:%M:%fZ', NEW.created_at, '-24 hours'
    )
)
BEGIN
  SELECT RAISE(ABORT, 'UNIQUE constraint failed: shareables.id');
END;

CREATE TRIGGER link_publication_consume_insert_attempt
AFTER INSERT ON shareables
WHEN NEW.visibility = 'link'
  AND EXISTS (
    SELECT 1 FROM link_publication_attempts AS attempt
    WHERE attempt.workspace_id = NEW.workspace_id
      AND attempt.shareable_id = NEW.id
  )
BEGIN
  INSERT INTO link_publications (
    workspace_id, shareable_id, latest_published_at
  )
  SELECT workspace_id, shareable_id, published_at
  FROM link_publication_attempts AS attempt
  WHERE attempt.workspace_id = NEW.workspace_id
    AND attempt.shareable_id = NEW.id
    AND (
      attempt.limit_applies = 0
      OR (
        SELECT COUNT(*) FROM link_publications AS publication
        WHERE publication.workspace_id = attempt.workspace_id
          AND publication.latest_published_at > attempt.window_start
      ) < attempt.daily_limit
    )
  ON CONFLICT (workspace_id, shareable_id) DO UPDATE SET
    latest_published_at = MAX(
      link_publications.latest_published_at,
      excluded.latest_published_at
    );

  SELECT RAISE(ABORT, 'link publication quota exceeded')
  WHERE changes() = 0;

  UPDATE link_publication_attempts
  SET consumed = 1
  WHERE workspace_id = NEW.workspace_id
    AND shareable_id = NEW.id;
END;

CREATE TRIGGER link_publication_consume_transition_attempt
AFTER UPDATE OF visibility ON shareables
WHEN OLD.visibility <> 'link'
  AND NEW.visibility = 'link'
  AND EXISTS (
    SELECT 1 FROM link_publication_attempts AS attempt
    WHERE attempt.workspace_id = NEW.workspace_id
      AND attempt.shareable_id = NEW.id
  )
BEGIN
  INSERT INTO link_publications (
    workspace_id, shareable_id, latest_published_at
  )
  SELECT workspace_id, shareable_id, published_at
  FROM link_publication_attempts AS attempt
  WHERE attempt.workspace_id = NEW.workspace_id
    AND attempt.shareable_id = NEW.id
    AND (
      attempt.limit_applies = 0
      OR (
        SELECT COUNT(*) FROM link_publications AS publication
        WHERE publication.workspace_id = attempt.workspace_id
          AND publication.latest_published_at > attempt.window_start
      ) < attempt.daily_limit
    )
  ON CONFLICT (workspace_id, shareable_id) DO UPDATE SET
    latest_published_at = MAX(
      link_publications.latest_published_at,
      excluded.latest_published_at
    );

  SELECT RAISE(ABORT, 'link publication quota exceeded')
  WHERE changes() = 0;

  UPDATE link_publication_attempts
  SET consumed = 1
  WHERE workspace_id = NEW.workspace_id
    AND shareable_id = NEW.id;
END;

CREATE TRIGGER link_publication_consume_link_update_attempt
AFTER UPDATE OF visibility ON shareables
WHEN OLD.visibility = 'link'
  AND NEW.visibility = 'link'
  AND EXISTS (
    SELECT 1 FROM link_publication_attempts AS attempt
    WHERE attempt.workspace_id = NEW.workspace_id
      AND attempt.shareable_id = NEW.id
  )
BEGIN
  UPDATE link_publication_attempts
  SET consumed = 1
  WHERE workspace_id = NEW.workspace_id
    AND shareable_id = NEW.id;
END;

CREATE TRIGGER link_publication_record_insert_without_attempt
AFTER INSERT ON shareables
WHEN NEW.visibility = 'link'
  AND NOT EXISTS (
    SELECT 1 FROM link_publication_attempts AS attempt
    WHERE attempt.workspace_id = NEW.workspace_id
      AND attempt.shareable_id = NEW.id
  )
BEGIN
  INSERT INTO link_publications (
    workspace_id, shareable_id, latest_published_at
  ) VALUES (
    NEW.workspace_id, NEW.id, NEW.created_at
  )
  ON CONFLICT (workspace_id, shareable_id) DO UPDATE SET
    latest_published_at = MAX(
      link_publications.latest_published_at,
      excluded.latest_published_at
    );
END;

CREATE TRIGGER link_publication_record_transition_without_attempt
AFTER UPDATE OF visibility ON shareables
WHEN OLD.visibility <> 'link'
  AND NEW.visibility = 'link'
  AND NOT EXISTS (
    SELECT 1 FROM link_publication_attempts AS attempt
    WHERE attempt.workspace_id = NEW.workspace_id
      AND attempt.shareable_id = NEW.id
  )
BEGIN
  INSERT INTO link_publications (
    workspace_id, shareable_id, latest_published_at
  ) VALUES (
    NEW.workspace_id, NEW.id, NEW.updated_at
  )
  ON CONFLICT (workspace_id, shareable_id) DO UPDATE SET
    latest_published_at = MAX(
      link_publications.latest_published_at,
      excluded.latest_published_at
    );
END;
