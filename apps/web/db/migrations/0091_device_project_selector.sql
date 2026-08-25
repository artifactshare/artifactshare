ALTER TABLE deviceCode ADD COLUMN requestedProjectSelector TEXT
  CHECK (
    requestedProjectSelector IS NULL
    OR (
      requestedProjectSelector = trim(requestedProjectSelector)
      AND length(requestedProjectSelector) BETWEEN 1 AND 120
    )
  );
