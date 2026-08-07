-- Migration: 0004_add_view_count
-- Denormalize view_count onto artifacts so the home gallery skips the
-- LEFT JOIN views + COUNT(*) GROUP BY scan. Counter is best-effort:
-- recordView bumps it next to the views INSERT; an occasional missed
-- increment is acceptable for a display number.
--
-- Backfill seeds the column from existing views so post-migration reads
-- match what the old aggregate queries returned.

ALTER TABLE artifacts ADD COLUMN view_count INTEGER NOT NULL DEFAULT 0;

UPDATE artifacts
SET view_count = (
  SELECT COUNT(*) FROM views WHERE views.artifact_id = artifacts.id
);
